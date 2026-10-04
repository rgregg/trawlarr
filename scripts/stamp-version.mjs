// Writes packages/server/dist/version.json, the version the daemon reports.
// `--print` prints it without writing (CI passes it to the Docker build).
//
// Precedence: TRAWLARR_VERSION (the Docker build has no .git — it is
// .dockerignored — so CI passes the version in), then `git describe` against
// a `v*` tag, then package.json's version plus the commit, then package.json
// alone. Without this the runtime status showed the package.json placeholder
// (0.0.0) on every build, which says nothing about what is deployed. The git
// tag is the only place a release version is written down.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'packages/server/package.json'), 'utf8'));

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveVersion() {
  const fromEnv = (process.env.TRAWLARR_VERSION ?? '').trim();
  if (fromEnv) return fromEnv.replace(/^v/, '');
  const dirty = git('status', '--porcelain', '--untracked-files=no') ? '.dirty' : '';
  const described = git('describe', '--tags', '--match', 'v*', '--long');
  if (described) {
    const m = /^v(.+)-(\d+)-g([0-9a-f]+)$/.exec(described);
    if (m) return m[2] === '0' && !dirty ? m[1] : `${m[1]}+${m[2]}.g${m[3]}${dirty}`;
  }
  const sha = git('rev-parse', '--short', 'HEAD');
  return sha ? `${pkg.version}+g${sha}${dirty}` : `${pkg.version}+unknown`;
}

const version = resolveVersion();
if (process.argv.includes('--print')) {
  console.log(version);
  process.exit(0);
}
const out = resolve(root, 'packages/server/dist/version.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ version }) + '\n');
console.log(`stamped version ${version}`);
