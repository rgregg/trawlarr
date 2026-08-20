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

/**
 * The root solution file must reference every package, or it is never built.
 *
 * ONE alternative is accepted, and only because it satisfies the same
 * invariant by another route: a package may type-check itself from its own
 * `build` script, provided the root `build` script actually runs it. That is
 * how `@trawlarr/web` is handled — it emits with Vite rather than
 * `tsc --build`, and its `.tsx` files need DOM lib and `jsx: react-jsx`,
 * neither of which the shared base config has. It is NOT a way to opt out:
 * both halves are checked here, so deleting either the package's own
 * type-check or the root script's call to it fails this gate exactly as a
 * missing reference would.
 */
const rootReferences = new Set(
  (readJsonc('tsconfig.json').references ?? []).map((reference) =>
    reference.path.replace(/^packages\//, ''),
  ),
);
const rootBuildScript = readJsonc('package.json').scripts?.build ?? '';
for (const dir of packageDirs) {
  if (rootReferences.has(dir)) continue;

  const manifest = readJsonc(join(PACKAGES_DIR, dir, 'package.json'));
  const ownBuild = manifest.scripts?.build ?? '';
  if (!ownBuild.includes('tsc --noEmit')) {
    problems.push(
      `tsconfig.json: missing root reference { "path": "packages/${dir}" } — ` +
        `packages/${dir} is never type-checked by \`pnpm build\`. A package outside the ` +
        `root solution must type-check itself with \`tsc --noEmit\` from its own build script.`,
    );
    continue;
  }
  if (!rootBuildScript.includes(manifest.name)) {
    problems.push(
      `package.json: the root "build" script never runs ${manifest.name}, so its own ` +
        `\`tsc --noEmit\` never runs either and packages/${dir} is unchecked by \`pnpm build\``,
    );
  }
}

if (problems.length > 0) {
  console.error(`Project reference problems (${problems.length}):`);
  for (const problem of problems.sort()) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Project references consistent across ${packageDirs.length} packages.`);
