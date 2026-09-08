import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
);
const releaseTag = process.argv[2];
const expectedTag = `v${manifest.version}`;

if (releaseTag !== expectedTag) {
  console.error(
    `WebMCP release tag must exactly match package version: expected ${expectedTag}, received ${releaseTag ?? '<missing>'}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Verified WebMCP release tag ${releaseTag}`);
}
