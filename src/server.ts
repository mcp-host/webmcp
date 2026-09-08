import { type Schema, Validator } from '@cfworker/json-schema';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { failClosedDiscoveryFetch } from './fail-closed-discovery-fetch';
import type { WebMcpAppManifest, WebMcpManifestTool } from './types';

const DEFAULT_MANIFEST_ORIGIN = 'https://mcp.host';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type WebMcpHandlerOptions<TUser> = {
  appId: string;
  secretKey: string;
  manifestUrl?: string;
  authenticate(request: Request): Promise<TUser | null | undefined>;
  authorize(input: {
    request: Request;
    user: TUser;
    tool: WebMcpManifestTool;
    arguments: Record<string, unknown>;
  }): Promise<boolean>;
  verifyCsrf(request: Request): Promise<boolean>;
};

export type WebMcpServerRuntime = {
  loadManifest(input: {
    appId: string;
    manifestUrl: string;
    signal: AbortSignal;
  }): Promise<WebMcpAppManifest>;
  invokeTool(input: {
    endpoint: string;
    secretKey: string;
    mcpName: string;
    tool: WebMcpManifestTool;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<unknown>;
};

export function createWebMcpHandler<TUser>(
  options: WebMcpHandlerOptions<TUser>,
  runtimeOverrides: Partial<WebMcpServerRuntime> = {},
): (request: Request) => Promise<Response> {
  if (!/^wmapp_[A-Za-z0-9_-]{1,120}$/.test(options.appId)) {
    throw new TypeError('Invalid WebMCP app ID');
  }
  if (!options.secretKey) {
    throw new TypeError('WebMCP server secret is required');
  }
  const manifestUrl =
    options.manifestUrl ??
    `${DEFAULT_MANIFEST_ORIGIN}/api/webmcp/apps/${encodeURIComponent(options.appId)}/manifest`;
  const runtime: WebMcpServerRuntime = {
    loadManifest: runtimeOverrides.loadManifest ?? loadWebMcpManifest,
    invokeTool: runtimeOverrides.invokeTool ?? invokeBundleTool,
  };

  return async (request) => {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed');
    }
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    ) {
      return errorResponse(415, 'unsupported_media_type');
    }
    const contentLength = request.headers.get('content-length');
    const declaredLength = contentLength === null ? 0 : Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_REQUEST_BYTES
    ) {
      return errorResponse(413, 'request_too_large');
    }

    const signal = combineSignals(
      request.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    try {
      const manifest = await runtime.loadManifest({
        appId: options.appId,
        manifestUrl,
        signal,
      });
      if (!isTrustedManifest(manifest, options.appId)) {
        return errorResponse(502, 'manifest_unavailable');
      }

      const requestOrigin = canonicalRequestOrigin(
        request.headers.get('origin'),
      );
      if (!requestOrigin || !manifest.origins.includes(requestOrigin)) {
        return errorResponse(403, 'origin_forbidden');
      }
      const fetchSite = request.headers.get('sec-fetch-site');
      if (fetchSite && fetchSite !== 'same-origin') {
        return errorResponse(403, 'origin_forbidden');
      }
      const bodyBytes = await readBoundedBytes(
        request.body,
        MAX_REQUEST_BYTES,
        new WebMcpHttpError(413, 'request_too_large'),
      );
      const csrfRequest = cloneWebStandardRequest(request, bodyBytes);
      const authenticationRequest = cloneWebStandardRequest(request, bodyBytes);
      const authorizationRequest = cloneWebStandardRequest(request, bodyBytes);
      if (!(await options.verifyCsrf(csrfRequest))) {
        return errorResponse(403, 'csrf_forbidden');
      }

      const user = await options.authenticate(authenticationRequest);
      if (user === null || user === undefined) {
        return errorResponse(401, 'authentication_required');
      }
      const body = parseRequestBody(bodyBytes);
      if (!isInvocationBody(body, options.appId)) {
        return errorResponse(400, 'invalid_request');
      }
      const tool = manifest.tools.find(
        (candidate) => candidate.id === body.toolId,
      );
      if (!tool) return errorResponse(404, 'tool_not_found');
      if (!validateArguments(tool, body.arguments)) {
        return errorResponse(400, 'invalid_arguments');
      }
      if (
        !(await options.authorize({
          request: authorizationRequest,
          user,
          tool,
          arguments: body.arguments,
        }))
      ) {
        return errorResponse(403, 'tool_forbidden');
      }

      const result = await runtime.invokeTool({
        endpoint: manifest.endpoint,
        secretKey: options.secretKey,
        mcpName: tool.mcpName,
        tool,
        arguments: body.arguments,
        signal,
      });
      if (!isBoundedJson(result, MAX_RESPONSE_BYTES)) {
        return errorResponse(502, 'invalid_tool_result');
      }
      return Response.json(
        { result },
        {
          status: 200,
          headers: { 'cache-control': 'no-store' },
        },
      );
    } catch (error) {
      if (signal.aborted) return errorResponse(408, 'request_timeout');
      if (error instanceof WebMcpHttpError) {
        return errorResponse(error.status, error.code);
      }
      return errorResponse(502, 'hosted_invocation_failed');
    }
  };
}

export async function loadWebMcpManifest(input: {
  appId: string;
  manifestUrl: string;
  signal: AbortSignal;
  headers?: HeadersInit;
  fetch?: (
    resource: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}): Promise<WebMcpAppManifest> {
  const headers = new Headers(input.headers);
  headers.set('accept', 'application/json');
  const response = await (input.fetch ?? globalThis.fetch)(input.manifestUrl, {
    method: 'GET',
    headers,
    // Some edge runtimes reject `redirect: 'error'`. Manual mode is portable,
    // and the non-2xx check below rejects redirects without ever forwarding the
    // app manifest request to another origin.
    redirect: 'manual',
    cache: 'no-store',
    signal: input.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('manifest_unavailable');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('manifest_too_large');
    }
  }
  const text = new TextDecoder().decode(
    await readBoundedBytes(
      response.body,
      MAX_RESPONSE_BYTES,
      'manifest_too_large',
    ),
  );
  const manifest = JSON.parse(text) as unknown;
  if (!isTrustedManifest(manifest, input.appId)) {
    throw new Error('invalid_manifest');
  }
  return manifest;
}

async function invokeBundleTool(input: {
  endpoint: string;
  secretKey: string;
  mcpName: string;
  tool: WebMcpManifestTool;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<unknown> {
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== 'https:' ||
    (endpoint.hostname !== 'mcp.link' &&
      !endpoint.hostname.endsWith('.mcp.link'))
  ) {
    throw new Error('invalid_bundle_endpoint');
  }

  const boundedFetch = failClosedDiscoveryFetch(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request =
        resource instanceof Request
          ? new Request(resource, init)
          : new Request(resource, init);
      const response = await fetch(
        new Request(request, {
          redirect: 'manual',
          signal: combineSignals(request.signal, input.signal),
        }),
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('redirect_forbidden');
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('response_too_large');
      }
      const bytes = await readBoundedBytes(
        response.body,
        MAX_RESPONSE_BYTES,
        'response_too_large',
      );
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  );
  const client = new Client(
    { name: '@mcp-host/webmcp', version: '0.1.0' },
    {
      versionNegotiation: { mode: 'auto' },
      defaultCacheTtlMs: 0,
      inputRequired: { autoFulfill: false },
    },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { authorization: `Bearer ${input.secretKey}` },
    },
    fetch: boundedFetch,
  });
  try {
    await client.connect(transport, { signal: input.signal });
    if (client.getProtocolEra() !== 'modern') {
      throw new Error('legacy_bundle_forbidden');
    }
    return await client.callTool(
      { name: input.mcpName, arguments: input.arguments },
      {
        toolDefinition: {
          name: input.mcpName,
          description: input.tool.description,
          inputSchema: input.tool.inputSchema as { type: 'object' },
          ...(input.tool.annotations
            ? { annotations: input.tool.annotations }
            : {}),
        },
        signal: input.signal,
      },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

function validateArguments(
  tool: WebMcpManifestTool,
  argumentsValue: Record<string, unknown>,
): boolean {
  return new Validator(tool.inputSchema as Schema, '2020-12', true).validate(
    argumentsValue,
  ).valid;
}

function isInvocationBody(
  value: unknown,
  expectedAppId: string,
): value is {
  appId: string;
  toolId: string;
  arguments: Record<string, unknown>;
} {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some(
      (key) => !['appId', 'toolId', 'arguments'].includes(key),
    )
  ) {
    return false;
  }
  return (
    value.appId === expectedAppId &&
    typeof value.toolId === 'string' &&
    value.toolId.length > 0 &&
    value.toolId.length <= 160 &&
    isRecord(value.arguments)
  );
}

function isTrustedManifest(
  value: unknown,
  expectedAppId: string,
): value is WebMcpAppManifest {
  if (!isRecord(value)) return false;
  return (
    value.manifestVersion === 1 &&
    value.appId === expectedAppId &&
    value.status === 'active' &&
    Number.isInteger(value.configurationVersion) &&
    typeof value.catalogFingerprint === 'string' &&
    typeof value.endpoint === 'string' &&
    Array.isArray(value.origins) &&
    value.origins.every((origin) => typeof origin === 'string') &&
    Array.isArray(value.tools) &&
    value.tools.length <= 500 &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.id === 'string' &&
        typeof tool.name === 'string' &&
        typeof tool.mcpName === 'string' &&
        isValidToolDescription(tool.description) &&
        isRecord(tool.inputSchema) &&
        isValidToolAnnotations(tool.annotations),
    )
  );
}

function parseRequestBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new WebMcpHttpError(400, 'invalid_request');
  }
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLarge: string | Error,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw typeof tooLarge === 'string' ? new Error(tooLarge) : tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function canonicalRequestOrigin(origin: string | null): string | undefined {
  if (!origin) return undefined;
  try {
    const parsed = new URL(origin);
    return parsed.href === `${parsed.origin}/` ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function combineSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([left, right]);
  }
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  if (left.aborted) abort(left);
  else if (right.aborted) abort(right);
  else {
    left.addEventListener('abort', () => abort(left), { once: true });
    right.addEventListener('abort', () => abort(right), { once: true });
  }
  return controller.signal;
}

function cloneWebStandardRequest(request: Request, body: Uint8Array): Request {
  // Cloudflare attaches request metadata as additional type parameters. The
  // callback receives a fresh request reconstructed from the already bounded
  // body, so callback reads cannot cause unbounded buffering.
  return new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    const json = JSON.stringify(value);
    return (
      json !== undefined &&
      new TextEncoder().encode(json).byteLength <= maxBytes
    );
  } catch {
    return false;
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: code } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidToolDescription(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidToolAnnotations(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    'readOnlyHint',
    'untrustedContentHint',
    'consequentialHint',
  ]);
  return Object.entries(value).every(
    ([key, entry]) => allowedKeys.has(key) && typeof entry === 'boolean',
  );
}

class WebMcpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
