import { type Schema, Validator } from '@cfworker/json-schema';

import { isWebMcpToolName, normalizeWebMcpToolName } from './names';
import type {
  WebMcpAppManifest,
  WebMcpHostedExecutor,
  WebMcpJsonSchema,
  WebMcpLocalTool,
  WebMcpManifestTool,
  WebMcpToolAnnotations,
} from './types';

const DEFAULT_MANIFEST_ORIGIN = 'https://mcp.host';
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;

type NativeWebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: WebMcpJsonSchema;
  annotations?: WebMcpToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

type NativeModelContext = {
  registerTool(
    tool: NativeWebMcpTool,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
};

type Registration = {
  controller: AbortController;
  fingerprint: string;
  name: string;
  ready: Promise<void>;
};

export class WebMcpSdkError extends Error {
  constructor(
    readonly code:
      | 'disposed'
      | 'invalid_arguments'
      | 'invalid_manifest'
      | 'invalid_result'
      | 'request_failed'
      | 'tool_registration_failed',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'WebMcpSdkError';
  }
}

export type WebMcpApp = {
  readonly appId: string;
  readonly status: 'ready' | 'unsupported' | 'degraded';
  registerLocalTool(tool: WebMcpLocalTool): Promise<void>;
  registerHostedTools(input: { executor: WebMcpHostedExecutor }): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
};

export async function createWebMcpApp(input: {
  appId: string;
  manifestUrl?: string;
}): Promise<WebMcpApp> {
  if (!/^wmapp_[A-Za-z0-9_-]{1,120}$/.test(input.appId)) {
    throw new WebMcpSdkError('invalid_manifest', 'Invalid WebMCP app ID');
  }

  const modelContext = resolveModelContext();
  const manifestUrl =
    input.manifestUrl ??
    `${DEFAULT_MANIFEST_ORIGIN}/api/webmcp/apps/${encodeURIComponent(input.appId)}/manifest`;
  const localRegistrations = new Map<string, Registration>();
  const hostedRegistrations = new Map<string, Registration>();
  let executor: WebMcpHostedExecutor | undefined;
  let disposed = false;
  let status: WebMcpApp['status'] = modelContext ? 'ready' : 'unsupported';

  const ensureActive = () => {
    if (disposed) throw new WebMcpSdkError('disposed');
  };

  const registerNative = async (
    tool: NativeWebMcpTool,
    fingerprint: string,
    registrations: Map<string, Registration>,
  ) => {
    if (!modelContext) return;
    const existing = registrations.get(tool.name);
    if (existing?.fingerprint === fingerprint) {
      await existing.ready;
      return;
    }
    existing?.controller.abort();
    const controller = new AbortController();
    const registration: Registration = {
      controller,
      fingerprint,
      name: tool.name,
      ready: Promise.resolve(),
    };
    registrations.set(tool.name, registration);
    registration.ready = (async () => {
      try {
        await modelContext.registerTool(tool, { signal: controller.signal });
        if (disposed || controller.signal.aborted) {
          throw new WebMcpSdkError('disposed');
        }
      } catch (error) {
        controller.abort();
        const isCurrent = registrations.get(tool.name) === registration;
        if (isCurrent) registrations.delete(tool.name);
        if (disposed) throw new WebMcpSdkError('disposed');
        if (isCurrent) status = 'degraded';
        if (error instanceof WebMcpSdkError) throw error;
        throw new WebMcpSdkError(
          'tool_registration_failed',
          error instanceof Error ? error.message : undefined,
        );
      }
    })();
    await registration.ready;
  };

  const refreshHosted = async () => {
    ensureActive();
    if (!modelContext || !executor) return;
    const manifest = await fetchManifest(manifestUrl, input.appId);
    const pageOrigin = globalThis.location?.origin;
    if (!pageOrigin || !manifest.origins.includes(pageOrigin)) {
      throw new WebMcpSdkError(
        'invalid_manifest',
        'The current page origin is not registered for this WebMCP app',
      );
    }
    const conflictingTool = manifest.tools.find((tool) =>
      localRegistrations.has(tool.name),
    );
    if (conflictingTool) {
      throw new WebMcpSdkError(
        'tool_registration_failed',
        `Tool name already registered locally: ${conflictingTool.name}`,
      );
    }
    const incomingNames = new Set(manifest.tools.map((tool) => tool.name));
    for (const [name, registration] of hostedRegistrations) {
      if (!incomingNames.has(name)) {
        registration.controller.abort();
        hostedRegistrations.delete(name);
      }
    }

    for (const tool of manifest.tools) {
      const fingerprint = stableToolFingerprint(tool);
      await registerNative(
        toHostedNativeTool(input.appId, tool, executor),
        fingerprint,
        hostedRegistrations,
      );
    }
  };

  return {
    appId: input.appId,
    get status() {
      return status;
    },
    async registerLocalTool(tool) {
      ensureActive();
      if (!modelContext) return;
      if (!isValidToolDescription(tool.description)) {
        throw new WebMcpSdkError(
          'tool_registration_failed',
          'Tool description must not be empty',
        );
      }
      if (!isValidToolAnnotations(tool.annotations)) {
        throw new WebMcpSdkError(
          'tool_registration_failed',
          'Tool annotations must contain only supported boolean hints',
        );
      }
      const name = await normalizeWebMcpToolName(tool.name);
      if (hostedRegistrations.has(name)) {
        throw new WebMcpSdkError(
          'tool_registration_failed',
          `Tool name already registered: ${name}`,
        );
      }
      const normalized = { ...tool, name };
      await registerNative(
        toLocalNativeTool(normalized),
        stableToolFingerprint(normalized),
        localRegistrations,
      );
    },
    async registerHostedTools(hostedInput) {
      ensureActive();
      executor = hostedInput.executor;
      await refreshHosted();
    },
    async refresh() {
      await refreshHosted();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of [
        ...localRegistrations.values(),
        ...hostedRegistrations.values(),
      ]) {
        registration.controller.abort();
      }
      localRegistrations.clear();
      hostedRegistrations.clear();
    },
  };
}

export function createSameOriginExecutor(input: {
  endpoint: string;
  getCsrfToken?: () => Promise<string | null> | string | null;
}): WebMcpHostedExecutor {
  if (!input.endpoint.startsWith('/') || input.endpoint.startsWith('//')) {
    throw new TypeError('WebMCP invocation endpoint must be same-origin');
  }

  return async ({ appId, toolId, arguments: argumentsValue, signal }) => {
    signal.throwIfAborted();
    const origin = globalThis.location?.origin;
    if (!origin) {
      throw new WebMcpSdkError('request_failed', 'Page origin is unavailable');
    }
    const endpoint = new URL(input.endpoint, origin);
    if (endpoint.origin !== origin) {
      throw new TypeError('WebMCP invocation endpoint must be same-origin');
    }
    const csrfToken = await input.getCsrfToken?.();
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-mcp-host-webmcp': '1',
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    let response: Response;
    try {
      response = await fetch(endpoint.href, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers,
        body: JSON.stringify({ appId, toolId, arguments: argumentsValue }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new WebMcpSdkError(
        'request_failed',
        error instanceof Error ? error.message : undefined,
      );
    }

    const envelope = await readBoundedJson(response, MAX_RESULT_BYTES);
    if (!response.ok || !isRecord(envelope) || !('result' in envelope)) {
      const message =
        isRecord(envelope) &&
        isRecord(envelope.error) &&
        typeof envelope.error.message === 'string'
          ? envelope.error.message
          : 'Hosted WebMCP invocation failed';
      throw new WebMcpSdkError('request_failed', message);
    }
    assertJsonSerializable(envelope.result);
    return envelope.result;
  };
}

function resolveModelContext(): NativeModelContext | undefined {
  if (typeof document === 'undefined') return undefined;
  if (
    typeof window !== 'undefined' &&
    window.top !== null &&
    window.top !== window.self
  ) {
    return undefined;
  }
  const candidate = (document as Document & { modelContext?: unknown })
    .modelContext;
  if (
    !candidate ||
    typeof (candidate as NativeModelContext).registerTool !== 'function'
  ) {
    return undefined;
  }
  return candidate as NativeModelContext;
}

function toLocalNativeTool(tool: WebMcpLocalTool): NativeWebMcpTool {
  return {
    ...tool,
    execute: async (argumentsValue, options) => {
      validateArguments(tool.inputSchema, argumentsValue);
      const result = await tool.execute(argumentsValue, {
        signal: options?.signal ?? new AbortController().signal,
      });
      assertJsonSerializable(result);
      return result;
    },
  };
}

function toHostedNativeTool(
  appId: string,
  tool: WebMcpManifestTool,
  executor: WebMcpHostedExecutor,
): NativeWebMcpTool {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    execute: async (argumentsValue, options) => {
      validateArguments(tool.inputSchema, argumentsValue);
      const signal = options?.signal ?? new AbortController().signal;
      const result = await executor({
        appId,
        toolId: tool.id,
        arguments: argumentsValue,
        signal,
      });
      assertJsonSerializable(result);
      return result;
    },
  };
}

function validateArguments(
  schema: WebMcpJsonSchema | undefined,
  argumentsValue: Record<string, unknown>,
) {
  if (!schema) return;
  const result = new Validator(schema as Schema, '2020-12', true).validate(
    argumentsValue,
  );
  if (!result.valid) {
    throw new WebMcpSdkError('invalid_arguments');
  }
}

async function fetchManifest(
  url: string,
  expectedAppId: string,
): Promise<WebMcpAppManifest> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new WebMcpSdkError(
      'request_failed',
      error instanceof Error ? error.message : undefined,
    );
  }
  if (!response.ok) throw new WebMcpSdkError('request_failed');
  const value = await readBoundedJson(response, MAX_MANIFEST_BYTES);
  if (!isManifest(value, expectedAppId)) {
    throw new WebMcpSdkError('invalid_manifest');
  }
  return value;
}

function isManifest(
  value: unknown,
  expectedAppId: string,
): value is WebMcpAppManifest {
  if (!isRecord(value)) return false;
  if (
    value.manifestVersion !== 1 ||
    value.appId !== expectedAppId ||
    value.status !== 'active' ||
    !Number.isInteger(value.configurationVersion) ||
    typeof value.catalogFingerprint !== 'string' ||
    typeof value.endpoint !== 'string' ||
    !Array.isArray(value.origins) ||
    !Array.isArray(value.tools) ||
    value.tools.length > 500
  ) {
    return false;
  }
  const toolsValid = value.tools.every(
    (tool) =>
      isRecord(tool) &&
      typeof tool.id === 'string' &&
      typeof tool.name === 'string' &&
      isWebMcpToolName(tool.name) &&
      typeof tool.mcpName === 'string' &&
      isValidToolDescription(tool.description) &&
      isRecord(tool.inputSchema) &&
      isValidToolAnnotations(tool.annotations),
  );
  if (!toolsValid) return false;
  const ids = value.tools.map((tool) => tool.id);
  const names = value.tools.map((tool) => tool.name);
  return (
    new Set(ids).size === ids.length && new Set(names).size === names.length
  );
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  const declared = contentLength === null ? 0 : Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
    throw new WebMcpSdkError('request_failed');
  }
  const text = new TextDecoder().decode(
    await readBoundedBytes(response.body, maxBytes),
  );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebMcpSdkError('request_failed');
  }
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
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
        throw new WebMcpSdkError('request_failed');
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

function stableToolFingerprint(
  tool: WebMcpLocalTool | WebMcpManifestTool,
): string {
  return JSON.stringify({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations ?? {},
  });
}

function assertJsonSerializable(value: unknown): void {
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).byteLength > MAX_RESULT_BYTES
    ) {
      throw new Error('not serializable');
    }
  } catch {
    throw new WebMcpSdkError('invalid_result');
  }
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
