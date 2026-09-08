export type WebMcpJsonSchema = Record<string, unknown>;

export type WebMcpToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
};

export type WebMcpExecuteOptions = {
  signal: AbortSignal;
};

export type WebMcpLocalTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: WebMcpJsonSchema;
  annotations?: WebMcpToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options: WebMcpExecuteOptions,
  ) => Promise<unknown> | unknown;
};

export type WebMcpManifestTool = {
  id: string;
  name: string;
  mcpName: string;
  title?: string;
  description: string;
  inputSchema: WebMcpJsonSchema;
  annotations?: WebMcpToolAnnotations;
};

export type WebMcpAppManifest = {
  manifestVersion: 1;
  appId: string;
  status: 'active';
  configurationVersion: number;
  catalogFingerprint: string;
  endpoint: string;
  origins: string[];
  tools: WebMcpManifestTool[];
};

export type WebMcpHostedExecutor = (input: {
  appId: string;
  toolId: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<unknown>;
