#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  // The bundled typefaces (@fontsource* / IBM Plex). The OFL permits
  // redistribution inside a larger work; what it forbids is selling the
  // fonts on their own and shipping a MODIFIED font under the reserved
  // name. Neither applies here — the woff2 files are passed through the
  // Vite build byte for byte.
  'OFL-1.1',
]);

const normalise = (l) => {
  if (!l) return null;
  const s = typeof l === 'string' ? l : l.type;
  if (!s) return null;
  return s
    .replace(/^\(|\)$/g, '')
    .split(/\s+OR\s+/i)
    .map((x) => x.trim());
};

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name === '.pnpm') {
      // pnpm's content-addressable store: node_modules/.pnpm/<key>/node_modules/<name>, where
      // <key> is the full "name@version[_peerHash]" string (and may itself start with '@' for
      // scoped packages). That is one level deeper than the plain-npm layout the generic branch
      // below assumes, so each store key is descended into explicitly.
      let storeEntries;
      try {
        storeEntries = await readdir(p, { withFileTypes: true });
      } catch {
        storeEntries = [];
      }
      for (const storeEntry of storeEntries) {
        if (!storeEntry.isDirectory()) continue;
        yield* walk(join(p, storeEntry.name, 'node_modules'));
      }
    } else if (e.name.startsWith('@')) {
      yield* walk(p);
    } else {
      yield p;
      yield* walk(join(p, 'node_modules'));
    }
  }
}

const problems = [];
const seen = new Set();
for (const root of ['node_modules', 'packages']) {
  for await (const dir of walk(root)) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name || seen.has(`${pkg.name}@${pkg.version}`)) continue;
    seen.add(`${pkg.name}@${pkg.version}`);
    if (pkg.name.startsWith('@trawlarr/')) continue;
    const licenses = normalise(pkg.license) ?? normalise(pkg.licenses?.[0]);
    if (!licenses || !licenses.some((l) => ALLOWED.has(l))) {
      problems.push(`${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.license ?? null)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Disallowed or unknown licenses (${problems.length}):`);
  for (const p of problems.sort()) console.error(`  ${p}`);
  console.error('\nAdd to ALLOWED only after confirming compatibility with MIT distribution.');
  process.exit(1);
}
console.log(`License audit passed: ${seen.size} packages checked.`);
