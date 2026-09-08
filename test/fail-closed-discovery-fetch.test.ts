import { describe, expect, it, vi } from 'vitest';

import { failClosedDiscoveryFetch } from '../src/fail-closed-discovery-fetch';

const discoveryRequest = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
  }),
} satisfies RequestInit;

describe('failClosedDiscoveryFetch', () => {
  it('accepts a valid complete discovery response', async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
        },
      }),
    );

    const response = await failClosedDiscoveryFetch(upstream)(
      'https://mcp.link/example/mcp',
      discoveryRequest,
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('allows an explicit JSON-RPC method-not-found response', async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      }),
    );

    await expect(
      failClosedDiscoveryFetch(upstream)(
        'https://mcp.link/example/mcp',
        discoveryRequest,
      ),
    ).resolves.toBeInstanceOf(Response);
  });

  it('rejects a method-not-found shape that is not a JSON-RPC response', async () => {
    const upstream = vi.fn(async () =>
      Response.json({ error: { code: -32601 } }),
    );

    await expect(
      failClosedDiscoveryFetch(upstream)(
        'https://mcp.link/example/mcp',
        discoveryRequest,
      ),
    ).rejects.toThrow('Origin discovery response is malformed');
  });

  it('rejects an invalid discovery result', async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: 'tools',
        },
      }),
    );

    await expect(
      failClosedDiscoveryFetch(upstream)(
        'https://mcp.link/example/mcp',
        discoveryRequest,
      ),
    ).rejects.toThrow('Origin discovery response is malformed');
  });
});
