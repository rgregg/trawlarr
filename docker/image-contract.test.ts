import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('the image records the commit it was built from', () => {
  it('bakes the TRAWLARR_COMMIT build argument into the environment the daemon reads', () => {
    expect(dockerfile).toMatch(/^ARG TRAWLARR_COMMIT=/m);
    expect(dockerfile).toMatch(/^ENV TRAWLARR_COMMIT=\$\{TRAWLARR_COMMIT\}$/m);
  });

  it('is passed that argument by the workflow that publishes it', () => {
    // A renamed argument on either side builds fine and reports a null commit
    // forever, which is the exact question this exists to answer.
    expect(ci).toMatch(/TRAWLARR_COMMIT=\$\{\{ github\.sha \}\}/);
  });

  it('declares the argument after every RUN, so a new commit does not rebuild the apt layers', () => {
    const lines = dockerfile.split('\n');
    const lastRun = lines.findLastIndex((line) => line.startsWith('RUN '));
    const arg = lines.findIndex((line) => line.startsWith('ARG TRAWLARR_COMMIT'));

    expect(arg).toBeGreaterThan(lastRun);
  });
});

describe('the image workflow', () => {
  it('publishes only after the checks pass', () => {
    expect(ci).toMatch(/^ {2}image:\n {4}needs: check$/m);
  });

  it('gives :latest only to a release tag, never to a pre-release', () => {
    const latest = /type=raw,value=latest,enable=\$\{\{ (.+) \}\}$/m.exec(ci)?.[1];

    expect(latest).toBe(`startsWith(github.ref, 'refs/tags/v') && !contains(github.ref, '-')`);
  });

  it('publishes a major-version tag, but not :0, which would promise a stable 0.x line', () => {
    expect(ci).toMatch(
      /^\s+type=semver,pattern=\{\{major\}\},enable=\$\{\{ !startsWith\(github\.ref, 'refs\/tags\/v0\.'\) \}\}$/m,
    );
  });
});

describe('the cluster CI job', () => {
  it('runs the cluster suite in a way that cannot pass by skipping', () => {
    expect(ci).toContain('\n  cluster:');
    const job = ci.slice(ci.indexOf('\n  cluster:'), ci.indexOf('\n  image:'));
    // Without this, a runner with no docker reports the suite green.
    expect(job).toMatch(/TRAWLARR_REQUIRE_DOCKER: '1'/);
    // The image under test is built from this commit and loaded, not pulled.
    expect(job).toMatch(/load: true/);
    expect(job).toMatch(/tags: trawlarr-cluster:dev/);
    // Both flags: the root vitest workspace wins over --config alone, and the
    // run then finds no cluster test at all.
    expect(job).toMatch(
      /vitest run --config vitest\.cluster\.config\.ts --workspace vitest\.cluster\.workspace\.ts/,
    );
  });
});
