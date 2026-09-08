import {
  DiscoverRequestSchema,
  DiscoverResultSchema,
  JSONRPCErrorResponseSchema,
  JSONRPCResultResponseSchema,
} from '@modelcontextprotocol/core';

const MAX_DISCOVERY_RESPONSE_BYTES = 64 * 1024;
const DEFINITIVE_LEGACY_HTTP_STATUSES = new Set([404, 405, 406, 415]);

type RuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ValidatedDiscoveryPayload =
  | { kind: 'error'; code: number }
  | { kind: 'complete-result' };

function malformedDiscovery(): Error {
  return new Error('Origin discovery response is malformed');
}

async function isDiscoveryRequest(
  resource: RequestInfo | URL,
  init?: RequestInit,
): Promise<boolean> {
  const request = new Request(resource, init);
  if (request.method !== 'POST') return false;
  try {
    return DiscoverRequestSchema.safeParse(await request.clone().json())
      .success;
  } catch {
    return false;
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const isEventStream = response.headers
    .get('content-type')
    ?.toLowerCase()
    .includes('text/event-stream');

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        return text;
      }
      bytes += value.byteLength;
      if (bytes > MAX_DISCOVERY_RESPONSE_BYTES) throw malformedDiscovery();
      text += decoder.decode(value, { stream: true });
      if (isEventStream && /\r?\n\r?\n/.test(text)) return text;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseDiscoveryPayload(text: string): ValidatedDiscoveryPayload {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  const candidate = data.at(-1) ?? text.trim();
  if (!candidate) throw malformedDiscovery();

  let payload: unknown;
  try {
    payload = JSON.parse(candidate);
  } catch {
    throw malformedDiscovery();
  }

  const errorResponse = JSONRPCErrorResponseSchema.safeParse(payload);
  if (errorResponse.success) {
    return { kind: 'error', code: errorResponse.data.error.code };
  }

  const resultResponse = JSONRPCResultResponseSchema.safeParse(payload);
  if (!resultResponse.success) {
    throw malformedDiscovery();
  }
  const result = resultResponse.data.result;
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result) ||
    !('resultType' in result) ||
    result.resultType !== 'complete' ||
    !DiscoverResultSchema.safeParse(result).success
  ) {
    throw malformedDiscovery();
  }

  return { kind: 'complete-result' };
}

async function assertFailClosedDiscoveryResponse(
  response: Response,
): Promise<void> {
  if (DEFINITIVE_LEGACY_HTTP_STATUSES.has(response.status)) return;
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status >= 500
  ) {
    return;
  }

  const payload = parseDiscoveryPayload(
    await readBoundedResponseText(response.clone()),
  );
  if (payload.kind === 'error') {
    if (payload.code === -32601 || payload.code === -32022) return;
    throw malformedDiscovery();
  }
}

/**
 * Prevent SDK auto-negotiation from interpreting malformed discovery replies
 * as legacy evidence. Only an explicit method-not-found response or the
 * standard legacy HTTP statuses may reach the SDK's fallback classifier.
 */
export function failClosedDiscoveryFetch(fetch: RuntimeFetch): RuntimeFetch {
  return async (resource, init) => {
    const discoveryRequest = await isDiscoveryRequest(resource, init);
    const response = await fetch(resource, init);
    if (discoveryRequest) {
      await assertFailClosedDiscoveryResponse(response);
    }
    return response;
  };
}
