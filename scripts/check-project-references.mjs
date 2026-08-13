#!/usr/bin/env node
/**
 * Every workspace dependency a package declares in package.json must also appear
 * as a TypeScript project reference in its tsconfig.json.
 *
 * Without the reference, `tsc --build` does not know the dependency must be built
 * first. That fails on a clean checkout ("Cannot find module '@trawlarr/...'"),
 * while passing locally for as long as a stale dist/ happens to be lying around —
 * so the failure shows up in CI and nowhere else. This exact omission survived
 * fifteen tasks and a whole-branch review because every local build was
 * incremental. This check is cheap; that class of bug is not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = 'packages';
const SCOPE = '@trawlarr/';

/** tsconfig.json permits comments and trailing commas; JSON.parse does not. */
const readJsonc = (path) => {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
};

const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** Map package name -> directory, so a dependency can be resolved to a path. */
const dirByName = new Map();
for (const dir of packageDirs) {
  const manifest = readJsonc(join(PACKAGES_DIR, dir, 'package.json'));
  dirByName.set(manifest.name, dir);
}

const problems = [];

for (const dir of packageDirs) {
  const manifestPath = join(PACKAGES_DIR, dir, 'package.json');
  const tsconfigPath = join(PACKAGES_DIR, dir, 'tsconfig.json');

  const manifest = readJsonc(manifestPath);
  const tsconfig = readJsonc(tsconfigPath);

  const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    name.startsWith(SCOPE),
  );
  const referenced = new Set(
    (tsconfig.references ?? []).map((reference) => reference.path.replace(/^\.\.\//, '')),
  );

  for (const dep of workspaceDeps) {
    const depDir = dirByName.get(dep);
    if (depDir === undefined) {
      problems.push(`${manifestPath}: depends on ${dep}, which is not a workspace package`);
      continue;
    }
    if (!referenced.has(depDir)) {
      problems.push(
        `${tsconfigPath}: missing project reference { "path": "../${depDir}" } ` +
          `for dependency ${dep}`,
      );
    }
  }
}

/** The root solution file must reference every package, or it is never built. */
const rootReferences = new Set(
  (readJsonc('tsconfig.json').references ?? []).map((reference) =>
    reference.path.replace(/^packages\//, ''),
  ),
);
for (const dir of packageDirs) {
  if (!rootReferences.has(dir)) {
    problems.push(
      `tsconfig.json: missing root reference { "path": "packages/${dir}" } — ` +
        `packages/${dir} is never type-checked by \`pnpm build\``,
    );
  }
}

if (problems.length > 0) {
  console.error(`Project reference problems (${problems.length}):`);
  for (const problem of problems.sort()) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Project references consistent across ${packageDirs.length} packages.`);
