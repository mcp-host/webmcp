import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-host-webmcp-package-'));
const packDirectory = join(temporaryRoot, 'pack');
const consumerDirectory = join(temporaryRoot, 'consumer');
const requestedTarball = process.argv[2];

function run(command, argumentsValue, options = {}) {
  return execFileSync(command, argumentsValue, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
}

function collectStrings(value, result = []) {
  if (typeof value === 'string') {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, result);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, result);
  }
  return result;
}

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });
  let tarball;
  if (requestedTarball) {
    tarball = resolve(packageRoot, requestedTarball);
    if (!tarball.endsWith('.tgz') || !existsSync(tarball)) {
      throw new Error(`Release tarball does not exist: ${requestedTarball}`);
    }
  } else {
    run('pnpm', ['pack', '--pack-destination', packDirectory], {
      cwd: packageRoot,
    });

    const tarballs = readdirSync(packDirectory).filter((entry) =>
      entry.endsWith('.tgz'),
    );
    if (tarballs.length !== 1) {
      throw new Error(`Expected one package tarball, found ${tarballs.length}`);
    }
    tarball = join(packDirectory, tarballs[0]);
  }
  const entries = run('tar', ['-tzf', tarball])
    .trim()
    .split('\n')
    .filter(Boolean);
  const allowedEntries =
    /^(package\/(dist\/|LICENSE$|README\.md$|package\.json$))/;
  const unexpectedEntries = entries.filter(
    (entry) => !allowedEntries.test(entry),
  );
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `Package contains unexpected files:\n${unexpectedEntries.join('\n')}`,
    );
  }
  for (const requiredEntry of [
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/browser.js',
    'package/dist/browser.d.ts',
    'package/dist/server.js',
    'package/dist/server.d.ts',
  ]) {
    if (!entries.includes(requiredEntry)) {
      throw new Error(`Package is missing ${requiredEntry}`);
    }
  }

  run('tar', ['-xzf', tarball, '-C', temporaryRoot]);
  const packedManifest = JSON.parse(
    readFileSync(join(temporaryRoot, 'package/package.json'), 'utf8'),
  );
  const manifestStrings = collectStrings(packedManifest);
  if (manifestStrings.some((value) => value.startsWith('workspace:'))) {
    throw new Error(
      'Published package metadata contains a workspace dependency',
    );
  }

  const shippedCode = entries
    .filter((entry) => entry.endsWith('.js') || entry.endsWith('.d.ts'))
    .map((entry) => readFileSync(join(temporaryRoot, entry), 'utf8'))
    .join('\n');
  if (shippedCode.includes('@mcp-host/mcp-protocol')) {
    throw new Error('Published code imports a monorepo-only protocol package');
  }
  if (/\b(?:wmsec|sk_live|mcp_live)_[A-Za-z0-9_-]{8,}\b/.test(shippedCode)) {
    throw new Error('Published code contains a credential-shaped value');
  }

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'webmcp-package-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@mcp-host/webmcp': `file:${tarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  run(
    'pnpm',
    ['install', '--ignore-scripts', '--config.auto-install-peers=false'],
    { cwd: consumerDirectory },
  );

  writeFileSync(
    join(consumerDirectory, 'runtime.mjs'),
    `import assert from 'node:assert/strict';
import { createWebMcpApp } from '@mcp-host/webmcp/browser';
import { createWebMcpHandler } from '@mcp-host/webmcp/server';

const app = await createWebMcpApp({ appId: 'wmapp_package_consumer' });
assert.equal(app.status, 'unsupported');
const handler = createWebMcpHandler({
  appId: 'wmapp_package_consumer',
  secretKey: 'package-consumer-placeholder',
  authenticate: async () => ({ id: 'consumer' }),
  authorize: async () => true,
  verifyCsrf: async () => true,
});
assert.equal(typeof handler, 'function');
`,
  );
  run('node', ['runtime.mjs'], { cwd: consumerDirectory });

  writeFileSync(
    join(consumerDirectory, 'types.ts'),
    `import type { WebMcpAppManifest } from '@mcp-host/webmcp';
import { createSameOriginExecutor, createWebMcpApp } from '@mcp-host/webmcp/browser';
import { createWebMcpHandler } from '@mcp-host/webmcp/server';

const manifest = {} as WebMcpAppManifest;
const executor = createSameOriginExecutor({ endpoint: '/api/webmcp/invoke' });
const appPromise = createWebMcpApp({ appId: manifest.appId });
const handler = createWebMcpHandler({
  appId: manifest.appId,
  secretKey: 'typecheck-placeholder',
  authenticate: async () => ({ id: 'consumer' }),
  authorize: async () => true,
  verifyCsrf: async () => true,
});
void executor;
void appPromise;
void handler;
`,
  );
  writeFileSync(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: 'ES2022',
        },
        include: ['types.ts'],
      },
      null,
      2,
    )}\n`,
  );
  run(resolve(packageRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
    cwd: consumerDirectory,
  });

  console.log(
    `Verified ${basename(tarball)} (${entries.length} files): runtime imports, declarations, contents, and credential redaction`,
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
