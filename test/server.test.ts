import { describe, expect, it, vi } from 'vitest';

import { createWebMcpHandler, loadWebMcpManifest } from '../src/server';
import type { WebMcpAppManifest } from '../src/types';

const manifest: WebMcpAppManifest = {
  manifestVersion: 1,
  appId: 'wmapp_shop',
  status: 'active',
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

describe('loadWebMcpManifest', () => {
  it('uses caller-provided server headers while returning a validated manifest', async () => {
    const fetchManifest = vi.fn(
      async (_resource: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe('manual');
        expect(headers.get('accept')).toBe('application/json');
        expect(headers.get('x-vercel-protection-bypass')).toBe(
          'staging-bypass',
        );
        return Response.json(manifest);
      },
    );

    await expect(
      loadWebMcpManifest({
        appId: manifest.appId,
        manifestUrl: 'https://staging.mcp.host/manifest',
        signal: new AbortController().signal,
        headers: { 'x-vercel-protection-bypass': 'staging-bypass' },
        fetch: fetchManifest,
      }),
    ).resolves.toEqual(manifest);
    expect(fetchManifest).toHaveBeenCalledOnce();
  });

  it('rejects redirects instead of following a manifest to another origin', async () => {
    const fetchManifest = vi.fn(async () =>
      Response.redirect('https://attacker.example/manifest', 302),
    );

    await expect(
      loadWebMcpManifest({
        appId: manifest.appId,
        manifestUrl: 'https://staging.mcp.host/manifest',
        signal: new AbortController().signal,
        fetch: fetchManifest,
      }),
    ).rejects.toThrow('manifest_unavailable');
    expect(fetchManifest).toHaveBeenCalledWith(
      'https://staging.mcp.host/manifest',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});

describe('createWebMcpHandler', () => {
  it('authorizes an opaque tool ID and invokes the trusted bundle mapping', async () => {
    const invokeTool = vi.fn(async () => ({ available: 4 }));
    const handler = createWebMcpHandler(
      {
        appId: 'wmapp_shop',
        secretKey: 'server-secret',
        authenticate: async () => ({ id: 'user-1' }),
        authorize: async ({ user, tool }) =>
          user.id === 'user-1' && tool.id === 'tool_inventory',
        verifyCsrf: async (request) =>
          request.headers.get('x-csrf-token') === 'csrf-value',
      },
      {
        loadManifest: async () => manifest,
        invokeTool,
      },
    );

    const response = await handler(
      new Request('https://shop.example/api/webmcp/invoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://shop.example',
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': 'csrf-value',
        },
        body: JSON.stringify({
          appId: 'wmapp_shop',
          toolId: 'tool_inventory',
          arguments: { sku: 'sku-1' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      result: { available: 4 },
    });
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.any(String),
        secretKey: 'server-secret',
        mcpName: 'inventory::lookup',
        tool: expect.objectContaining({
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
            consequentialHint: false,
          },
        }),
        arguments: { sku: 'sku-1' },
      }),
    );
    expect(JSON.stringify(payload)).not.toContain('server-secret');
  });

  it.each([
    {
      label: 'empty description',
      tool: { ...manifest.tools[0], description: '   ' },
    },
    {
      label: 'invalid annotation',
      tool: {
        ...manifest.tools[0],
        annotations: { consequentialHint: 'yes' },
      },
    },
  ])('rejects a trusted manifest with $label', async ({ tool }) => {
    const invokeTool = vi.fn();
    const handler = createWebMcpHandler(
      {
        appId: 'wmapp_shop',
        secretKey: 'server-secret',
        authenticate: async () => ({ id: 'user-1' }),
        authorize: async () => true,
        verifyCsrf: async () => true,
      },
      {
        loadManifest: async () => ({
          ...manifest,
          tools: [tool] as WebMcpAppManifest['tools'],
        }),
        invokeTool,
      },
    );

    const response = await handler(
      new Request('https://shop.example/api/webmcp/invoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://shop.example',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({
          appId: 'wmapp_shop',
          toolId: 'tool_inventory',
          arguments: { sku: 'sku-1' },
        }),
      }),
    );

    expect(response.status).toBe(502);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'wrong origin',
      origin: 'https://evil.example',
      csrf: 'csrf-value',
      toolId: 'tool_inventory',
      expected: 403,
    },
    {
      label: 'failed CSRF',
      origin: 'https://shop.example',
      csrf: 'wrong',
      toolId: 'tool_inventory',
      expected: 403,
    },
    {
      label: 'unknown opaque tool ID',
      origin: 'https://shop.example',
      csrf: 'csrf-value',
      toolId: 'inventory::lookup',
      expected: 404,
    },
  ])('fails closed for $label', async ({ origin, csrf, toolId, expected }) => {
    const invokeTool = vi.fn();
    const handler = createWebMcpHandler(
      {
        appId: 'wmapp_shop',
        secretKey: 'server-secret',
        authenticate: async () => ({ id: 'user-1' }),
        authorize: async () => true,
        verifyCsrf: async (request) =>
          request.headers.get('x-csrf-token') === 'csrf-value',
      },
      { loadManifest: async () => manifest, invokeTool },
    );
    const response = await handler(
      new Request('https://shop.example/api/webmcp/invoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          appId: 'wmapp_shop',
          toolId,
          arguments: { sku: 'sku-1' },
        }),
      }),
    );
    expect(response.status).toBe(expected);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized JSON before invocation', async () => {
    const invokeTool = vi.fn();
    const handler = createWebMcpHandler(
      {
        appId: 'wmapp_shop',
        secretKey: 'server-secret',
        authenticate: async () => ({ id: 'user-1' }),
        authorize: async () => true,
        verifyCsrf: async () => true,
      },
      { loadManifest: async () => manifest, invokeTool },
    );
    const baseHeaders = {
      'content-type': 'application/json',
      origin: 'https://shop.example',
      'sec-fetch-site': 'same-origin',
    };
    const malformed = await handler(
      new Request('https://shop.example/api/webmcp/invoke', {
        method: 'POST',
        headers: baseHeaders,
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);

    const oversized = await handler(
      new Request('https://shop.example/api/webmcp/invoke', {
        method: 'POST',
        headers: { ...baseHeaders, 'content-length': String(300 * 1024) },
        body: '{}',
      }),
    );
    expect(oversized.status).toBe(413);

    const streamedOversized = await handler(
      new Request('https://shop.example/api/webmcp/invoke', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ payload: 'x'.repeat(300 * 1024) }),
      }),
    );
    expect(streamedOversized.status).toBe(413);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it.each([
    { authenticated: false, authorized: true, expected: 401 },
    { authenticated: true, authorized: false, expected: 403 },
  ])(
    'requires application authentication and tool authorization',
    async ({ authenticated, authorized, expected }) => {
      const invokeTool = vi.fn();
      const handler = createWebMcpHandler(
        {
          appId: 'wmapp_shop',
          secretKey: 'server-secret',
          authenticate: async () => (authenticated ? { id: 'user-1' } : null),
          authorize: async () => authorized,
          verifyCsrf: async () => true,
        },
        { loadManifest: async () => manifest, invokeTool },
      );
      const response = await handler(
        new Request('https://shop.example/api/webmcp/invoke', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://shop.example',
            'sec-fetch-site': 'same-origin',
          },
          body: JSON.stringify({
            appId: 'wmapp_shop',
            toolId: 'tool_inventory',
            arguments: { sku: 'sku-1' },
          }),
        }),
      );
      expect(response.status).toBe(expected);
      expect(invokeTool).not.toHaveBeenCalled();
    },
  );
});
