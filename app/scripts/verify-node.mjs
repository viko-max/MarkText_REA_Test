#!/usr/bin/env node
/**
 * Guards against accidentally running scripts with the host Node instead of
 * the isolated toolchain in `tools/node`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(appDir, '..', 'package.json'), 'utf8'));
const required = pkg.engines?.node ?? '>=22.23.4';

const [major, minor, patch] = process.versions.node.split('.').map(Number);
const minimum = required.replace(/^[^0-9]*/, '').split('.').map(Number);
const meetsMinimum =
  major > minimum[0] ||
  (major === minimum[0] && (minor > minimum[1] || (minor === minimum[1] && patch >= minimum[2])));

console.log(`node: ${process.execPath}`);
console.log(`version: ${process.versions.node} (required ${required})`);
console.log(`electron: ${JSON.parse(readFileSync(join(appDir, '..', 'node_modules', 'electron', 'package.json'), 'utf8')).version}`);

if (!meetsMinimum) {
  console.error('This Node version does not satisfy package.json engines.');
  process.exit(1);
}
