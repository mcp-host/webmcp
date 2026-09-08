import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSameOriginExecutor, createWebMcpApp } from '../src/browser';

type RegisteredTool = {
  name: string;
  description: string;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
    consequentialHint?: boolean;
  };
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

describe('WebMCP browser SDK', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['/\\attacker.example/invoke', '/\t/attacker.example/invoke'])(
    'rejects an endpoint that resolves cross-origin before reading CSRF: %s',
    async (endpoint) => {
      vi.stubGlobal('location', { origin: 'https://shop.example' });
      const fetchMock = vi.fn(async () => Response.json({ result: {} }));
      const getCsrfToken = vi.fn(() => 'csrf-value');
      vi.stubGlobal('fetch', fetchMock);

      await expect(async () => {
        const execute = createSameOriginExecutor({ endpoint, getCsrfToken });
        await execute({
          appId: 'wmapp_shop',
          toolId: 'tool_inventory',
          arguments: { sku: 'sku-1' },
          signal: new AbortController().signal,
        });
      }).rejects.toThrow('same-origin');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getCsrfToken).not.toHaveBeenCalled();
    },
  );

  it('registers local and hosted tools and unregisters both on dispose', async () => {
    const registered = new Map<
      string,
      { tool: RegisteredTool; signal?: AbortSignal }
    >();
    const modelContext = {
      registerTool: vi.fn(
        async (tool: RegisteredTool, options?: { signal?: AbortSignal }) => {
          registered.set(tool.name, { tool, signal: options?.signal });
          options?.signal?.addEventListener('abort', () => {
            registered.delete(tool.name);
          });
        },
      ),
    };
    vi.stubGlobal('document', { modelContext });
    vi.stubGlobal('location', { origin: 'https://shop.example' });

    const manifest = {
      manifestVersion: 1 as const,
      appId: 'wmapp_shop',
      status: 'active' as const,
      configurationVersion: 3,
      catalogFingerprint: 'f'.repeat(64),
      endpoint: 'https://mcp.link/u/user/my-tools/mcp',
      origins: ['https://shop.example'],
      tools: [
        {
          id: 'tool_inventory',
          name: 'mcp.inventory_lookup.123456789abc',
          mcpName: 'inventory::lookup',
          description: 'Look up current inventory.',
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
            consequentialHint: false,
          },
          inputSchema: {
            type: 'object',
            properties: { sku: { type: 'string' } },
            required: ['sku'],
            additionalProperties: false,
          },
        },
      ],
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.includes('/manifest')) {
          return Response.json(manifest);
        }
        return Response.json({ result: { available: 4 } });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = await createWebMcpApp({
      appId: 'wmapp_shop',
      manifestUrl: 'https://mcp.host/api/webmcp/apps/wmapp_shop/manifest',
    });
    await app.registerLocalTool({
      name: 'highlight_product',
      description: 'Highlight a product in the page.',
      inputSchema: {
        type: 'object',
        properties: { productId: { type: 'string' } },
        required: ['productId'],
      },
      execute: async ({ productId }) => ({ highlighted: productId }),
    });
    await app.registerHostedTools({
      executor: createSameOriginExecutor({
        endpoint: '/api/webmcp/invoke',
        getCsrfToken: () => 'csrf-value',
      }),
    });

    expect([...registered.keys()].sort()).toEqual([
      'highlight_product',
      'mcp.inventory_lookup.123456789abc',
    ]);
    expect(
      registered.get('mcp.inventory_lookup.123456789abc')!.tool.annotations,
    ).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
      consequentialHint: false,
    });
    const localResult = await registered
      .get('highlight_product')!
      .tool.execute(
        { productId: 'p-1' },
        { signal: new AbortController().signal },
      );
    expect(localResult).toEqual({ highlighted: 'p-1' });
    const hostedResult = await registered
      .get('mcp.inventory_lookup.123456789abc')!
      .tool.execute({ sku: 'sku-1' }, { signal: new AbortController().signal });
    expect(hostedResult).toEqual({ available: 4 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://shop.example/api/webmcp/invoke',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'x-csrf-token': 'csrf-value',
        }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls.at(-1)?.[1])).not.toMatch(
      /bearer|server-secret/i,
    );

    await expect(
      app.registerLocalTool({
        name: 'mcp.inventory_lookup.123456789abc',
        description: 'Conflicts with the hosted registration.',
        inputSchema: { type: 'object' },
        execute: async () => ({}),
      }),
    ).rejects.toThrow('already registered');

    app.dispose();
    expect(registered.size).toBe(0);
  });

  it('rejects empty descriptions and invalid hosted annotations before native registration', async () => {
    const modelContext = { registerTool: vi.fn(async () => undefined) };
    vi.stubGlobal('document', { modelContext });
    vi.stubGlobal('location', { origin: 'https://shop.example' });

    const app = await createWebMcpApp({
      appId: 'wmapp_shop',
      manifestUrl: 'https://mcp.host/manifest',
    });
    await expect(
      app.registerLocalTool({
        name: 'empty_description',
        description: '   ',
        inputSchema: { type: 'object' },
        execute: async () => ({}),
      }),
    ).rejects.toMatchObject({ code: 'tool_registration_failed' });
    expect(modelContext.registerTool).not.toHaveBeenCalled();

    await expect(
      app.registerLocalTool({
        name: 'invalid_annotations',
        description: 'Reject unsupported local annotations.',
        inputSchema: { type: 'object' },
        annotations: { consequentialHint: 'yes' } as never,
        execute: async () => ({}),
      }),
    ).rejects.toMatchObject({ code: 'tool_registration_failed' });
    expect(modelContext.registerTool).not.toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          manifestVersion: 1,
          appId: 'wmapp_shop',
          status: 'active',
          configurationVersion: 1,
          catalogFingerprint: 'f'.repeat(64),
          endpoint: 'https://mcp.link/u/user/my-tools/mcp',
          origins: ['https://shop.example'],
          tools: [
            {
              id: 'tool_inventory',
              name: 'inventory_lookup.123456789abc',
              mcpName: 'inventory::lookup',
              description: 'Look up current inventory.',
              inputSchema: { type: 'object' },
              annotations: { consequentialHint: 'yes' },
            },
          ],
        }),
      ),
    );
    await expect(
      app.registerHostedTools({ executor: async () => ({}) }),
    ).rejects.toMatchObject({ code: 'invalid_manifest' });
    expect(modelContext.registerTool).not.toHaveBeenCalled();
  });

  it('forwards per-call cancellation to local callbacks and hosted fetches', async () => {
    const registered = new Map<string, RegisteredTool>();
    const modelContext = {
      registerTool: vi.fn(async (tool: RegisteredTool) => {
        registered.set(tool.name, tool);
      }),
    };
    vi.stubGlobal('document', { modelContext });
    vi.stubGlobal('location', { origin: 'https://shop.example' });

    const manifest = {
      manifestVersion: 1,
      appId: 'wmapp_shop',
      status: 'active',
      configurationVersion: 1,
      catalogFingerprint: 'f'.repeat(64),
      endpoint: 'https://mcp.link/u/user/my-tools/mcp',
      origins: ['https://shop.example'],
      tools: [
        {
          id: 'tool_inventory',
          name: 'inventory_lookup.123456789abc',
          mcpName: 'inventory::lookup',
          description: 'Look up current inventory.',
          inputSchema: { type: 'object' },
        },
      ],
    };
    let invocationSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        if (String(resource).includes('/manifest')) {
          return Response.json(manifest);
        }
        invocationSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          invocationSignal?.addEventListener(
            'abort',
            () => reject(invocationSignal?.reason),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = await createWebMcpApp({
      appId: 'wmapp_shop',
      manifestUrl: 'https://mcp.host/manifest',
    });
    let localSignal: AbortSignal | undefined;
    await app.registerLocalTool({
      name: 'observe_signal',
      description: 'Observe cancellation for this local call.',
      execute: async (_arguments, { signal }) => {
        localSignal = signal;
        return { ok: true };
      },
    });
    await app.registerHostedTools({
      executor: createSameOriginExecutor({
        endpoint: '/api/webmcp/invoke',
      }),
    });

    const localController = new AbortController();
    await expect(
      registered
        .get('observe_signal')!
        .execute({}, { signal: localController.signal }),
    ).resolves.toEqual({ ok: true });
    expect(localSignal).toBe(localController.signal);

    const hostedController = new AbortController();
    const hostedCall = registered
      .get('inventory_lookup.123456789abc')!
      .execute({}, { signal: hostedController.signal });
    await vi.waitFor(() => expect(invocationSignal).toBeDefined());
    const reason = new Error('agent cancelled');
    hostedController.abort(reason);
    await expect(hostedCall).rejects.toBe(reason);
    expect(invocationSignal).toBe(hostedController.signal);
  });

  it('supplies a fallback signal when the native runtime omits execute options', async () => {
    const registered = new Map<string, RegisteredTool>();
    const modelContext = {
      registerTool: vi.fn(async (tool: RegisteredTool) => {
        registered.set(tool.name, tool);
      }),
    };
    vi.stubGlobal('document', { modelContext });
    vi.stubGlobal('location', { origin: 'https://shop.example' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (resource: RequestInfo | URL) => {
        if (String(resource).includes('/manifest')) {
          return Response.json({
            manifestVersion: 1,
            appId: 'wmapp_shop',
            status: 'active',
            configurationVersion: 1,
            catalogFingerprint: 'f'.repeat(64),
            endpoint: 'https://mcp.link/u/user/my-tools/mcp',
            origins: ['https://shop.example'],
            tools: [
              {
                id: 'tool_inventory',
                name: 'inventory_lookup.123456789abc',
                mcpName: 'inventory::lookup',
                description: 'Look up current inventory.',
                inputSchema: { type: 'object' },
              },
            ],
          });
        }
        return Response.json({ result: { available: 4 } });
      }),
    );

    const app = await createWebMcpApp({
      appId: 'wmapp_shop',
      manifestUrl: 'https://mcp.host/manifest',
    });
    let localSignal: AbortSignal | undefined;
    await app.registerLocalTool({
      name: 'observe_fallback_signal',
      description: 'Observe the fallback cancellation signal.',
      execute: async (_arguments, { signal }) => {
        localSignal = signal;
        return { ok: true };
      },
    });
    await app.registerHostedTools({
      executor: createSameOriginExecutor({
        endpoint: '/api/webmcp/invoke',
      }),
    });

    await expect(
      registered.get('observe_fallback_signal')!.execute({}),
    ).resolves.toEqual({ ok: true });
    expect(localSignal).toBeInstanceOf(AbortSignal);
    await expect(
      registered.get('inventory_lookup.123456789abc')!.execute({}),
    ).resolves.toEqual({ available: 4 });
  });

  it('aborts and rejects registration when disposed while the native call is pending', async () => {
    let registrationSignal: AbortSignal | undefined;
    const modelContext = {
      registerTool: vi.fn(
        async (_tool: RegisteredTool, options?: { signal?: AbortSignal }) => {
          registrationSignal = options?.signal;
          return await new Promise<void>((_resolve, reject) => {
            registrationSignal?.addEventListener(
              'abort',
              () => reject(registrationSignal?.reason),
              { once: true },
            );
          });
        },
      ),
    };
    vi.stubGlobal('document', { modelContext });

    const app = await createWebMcpApp({ appId: 'wmapp_shop' });
    const registration = app.registerLocalTool({
      name: 'pending_tool',
      description: 'Remain pending until the app is disposed.',
      execute: async () => ({ ok: true }),
    });
    await vi.waitFor(() => expect(registrationSignal).toBeDefined());
    app.dispose();

    expect(registrationSignal?.aborted).toBe(true);
    await expect(registration).rejects.toMatchObject({ code: 'disposed' });
  });

  it('is a no-op in unsupported browsers and rejects cross-origin executors', async () => {
    vi.stubGlobal('document', {});
    const app = await createWebMcpApp({ appId: 'wmapp_shop' });
    expect(app.status).toBe('unsupported');
    await expect(
      app.registerLocalTool({
        name: 'safe_noop',
        description: 'Does not register without native browser support.',
        inputSchema: { type: 'object' },
        execute: async () => ({}),
      }),
    ).resolves.toBeUndefined();
    expect(() =>
      createSameOriginExecutor({ endpoint: 'https://evil.example/invoke' }),
    ).toThrow('same-origin');
  });
});
