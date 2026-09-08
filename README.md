# `@mcp-host/webmcp`

Framework-agnostic WebMCP integration for browser-local tools and
[MCP Host](https://mcp.host) bundle tools. Hosted calls run through the
[mcp.link](https://mcp.link) gateway, while browser code receives only a public
app identifier and secret-free manifest. Protected calls always cross the
application's authenticated, same-origin backend; the server-only gateway
secret must never be included in browser bundles or public environment
variables.

```sh
pnpm add @mcp-host/webmcp
```

## Browser setup

```ts
import {
  createSameOriginExecutor,
  createWebMcpApp,
} from '@mcp-host/webmcp/browser';

const app = await createWebMcpApp({ appId: 'wmapp_...' });

await app.registerLocalTool({
  name: 'highlight_product',
  description: 'Highlight a product in the current page.',
  inputSchema: {
    type: 'object',
    properties: { productId: { type: 'string' } },
    required: ['productId'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    consequentialHint: false,
  },
  execute: async ({ productId }, { signal }) => {
    signal.throwIfAborted();
    highlightProduct(productId);
    return { highlighted: productId };
  },
});

await app.registerHostedTools({
  executor: createSameOriginExecutor({
    endpoint: '/api/webmcp/invoke',
    getCsrfToken: () => readCsrfToken(),
  }),
});
```

The SDK feature-detects the current `document.modelContext.registerTool()` API.
When it is unavailable, the page continues normally and the app reports an
`unsupported` status. Successful callbacks return their original
JSON-serializable value; do not pre-stringify structured results.

The initial compatibility profile registers only in the top-level document so
it works with ChatGPT Site Tools. WebMCP itself supports additional iframe
scenarios, but this SDK does not expose those delegation controls yet.

## Server setup

```ts
import { createWebMcpHandler } from '@mcp-host/webmcp/server';

export const POST = createWebMcpHandler({
  appId: process.env.MCP_HOST_WEBMCP_APP_ID!,
  secretKey: process.env.MCP_HOST_WEBMCP_SECRET_KEY!,
  authenticate: requireApplicationUser,
  authorize: canApplicationUserUseTool,
  verifyCsrf: verifyApplicationCsrf,
});
```

Local tools are registered with `registerLocalTool` and execute entirely in the
page. Call `dispose()` during navigation or unmount to unregister all tools.
Keep tool inputs narrow, describe side effects explicitly, and repeat your
application's normal authorization checks in `authorize`. Local-tool execution
is not governed, billed, or authenticated by MCP Host; hosted execution is
attributed to the registered WebMCP app service principal, not to a verified
browser-agent identity.

Descriptions must contain non-whitespace text. The control plane marks hosted
tools that are not explicitly read-only as consequential. These annotations
are advisory signals for browser UX and never replace server-side
authorization.

## Package verification

The published package contains compiled ESM and declarations for `.`,
`./browser`, and `./server`; consumers do not compile MCP Host workspace source.
Run `pnpm verify:package` to build a tarball, reject unexpected files or
workspace-only imports, install it into an isolated clean consumer, and verify
both runtime and TypeScript imports. Publishing remains an explicit release
operation and is not performed by this command.

The canonical public source and release history live at
[`mcp-host/webmcp`](https://github.com/mcp-host/webmcp). Releases are published
from that public repository with npm provenance.
