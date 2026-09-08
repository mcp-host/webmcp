const WEBMCP_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function isWebMcpToolName(name: string): boolean {
  return WEBMCP_NAME.test(name);
}

export async function normalizeWebMcpToolName(name: string): Promise<string> {
  if (WEBMCP_NAME.test(name)) return name;
  const hash = await sha256Prefix(name, 12);
  const sanitized =
    name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '') ||
    'tool';
  const suffix = `.${hash}`;
  return `${sanitized.slice(0, 128 - suffix.length)}${suffix}`;
}

export async function createWebMcpToolId(mcpName: string): Promise<string> {
  return `wmtool_${await sha256Prefix(mcpName, 24)}`;
}

async function sha256Prefix(value: string, length: number): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}
