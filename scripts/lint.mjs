// Stub / unsafe-API gate from docs/CODING_CONTRACT.md §2.1 and §7. Run from a package dir: scans ./src (or argv[2]).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BANNED =
  /\b(?:TODO|FIXME|XXX|HACK)\b|not implemented|\bas any\b|@ts-ignore|dangerouslySetInnerHTML|\.innerHTML\b|insertAdjacentHTML|document\.write\(/;
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo']);
const EXT = /\.(?:ts|tsx|js|mjs|cjs|jsx)$/;

const root = process.argv[2] ?? 'src';
const hits = [];

const files = existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }) : [];
for (const e of files) {
  if (!e.isFile() || !EXT.test(e.name) || relative(root, e.parentPath).split(sep).some((d) => SKIP.has(d))) continue;
  const path = join(e.parentPath, e.name);
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
}

if (hits.length > 0) {
  console.error(`STUB FOUND\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('clean');
