import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_BINDINGS } from '../packages/server/src/config/env-settings.js';

/** Variables the ENTRYPOINT or the container runtime reads, not the daemon. */
const RUNTIME_VARS = new Set([
  'PUID',
  'PGID',
  'TZ',
  'NVIDIA_VISIBLE_DEVICES',
  'NVIDIA_DRIVER_CAPABILITIES',
  // Read by the entrypoint (TRAWLARR_MODE) and by `trawlarr node` directly
  // (TRAWLARR_SERVER, TRAWLARR_NODE_TOKEN) — a node has no daemon and so
  // none of these are ENV_BINDINGS.
  'TRAWLARR_MODE',
  'TRAWLARR_SERVER',
  'TRAWLARR_NODE_TOKEN',
]);

// The cluster file is a TEST FIXTURE (docker/cluster/), not a deployment: it
// sets NODE_ENV=test and test-only seams, has no fixed hostname and no drain
// period. It is held to its own contract below, not to a deployment's.
const CLUSTER_FIXTURE = join('docker', 'compose.cluster.yml');

const composeFiles = readdirSync('docker')
  .filter((name) => name.startsWith('compose') && name.endsWith('.yml'))
  .map((name) => join('docker', name))
  .filter((file) => file !== CLUSTER_FIXTURE);

// Files that run the DAEMON (a server): a fixed hostname, a 5-minute drain
// and the published API port all exist because of the daemon's own
// behaviour, and a node has none of them (see the node-specific describe
// block below).
const serverComposeFiles = composeFiles.filter((file) => !file.includes('compose.node'));

describe('compose files', () => {
  it('are all discovered (a renamed file must not make this suite vacuous)', () => {
    expect(composeFiles).toContain('docker/compose.yml');
    expect(composeFiles).toContain('docker/compose.nvidia.yml');
    expect(composeFiles).toContain('docker/compose.node.yml');
  });

  it.each(composeFiles)('%s sets only variables trawlarr reads', (file) => {
    const known = new Set([...ENV_BINDINGS.map((binding) => binding.name), ...RUNTIME_VARS]);
    const body = readFileSync(file, 'utf8');
    // The `environment:` block is a YAML list of `- NAME=value` entries.
    const declared = [...body.matchAll(/^\s+-\s+([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !known.has(name))).toEqual([]);
  });

  // A killed worker is recognised as gone by (hostname, pid). Without a fixed
  // hostname, every image update changes it and an interrupted file waits a
  // day in "running"; without the grace period, Docker kills the daemon 10s
  // into a drain that is built to wait 5 minutes.
  it.each(serverComposeFiles)('%s keeps the hostname fixed and lets the daemon drain', (file) => {
    const body = readFileSync(file, 'utf8');
    expect(body).toMatch(/^\s+hostname:\s+\S+/m);
    expect(body).toMatch(/^\s+stop_grace_period:\s+5m\b/m);
  });

  it('publish the daemon port the image binds', () => {
    for (const file of serverComposeFiles) {
      expect(readFileSync(file, 'utf8')).toContain('8265');
    }
  });
});

describe('the node variant', () => {
  const body = readFileSync('docker/compose.node.yml', 'utf8');

  it('runs the same image as the server compose file', () => {
    // Selected by environment, not by a second image: a GPU host runs
    // exactly the build its server does.
    const imageOf = (file: string): string =>
      /^\s+image:\s+(\S+)$/m.exec(readFileSync(file, 'utf8'))![1]!;

    expect(imageOf('docker/compose.node.yml')).toBe(imageOf('docker/compose.yml'));
  });

  it('publishes no ports: a node connects out, it never accepts inbound connections', () => {
    expect(body).not.toMatch(/^\s*ports:/m);
  });

  it("disables the image's HTTP healthcheck in every node service, which has no HTTP server to answer it", () => {
    // The image's HEALTHCHECK polls the daemon's port. A node never listens,
    // so left enabled every node container reports unhealthy for ever.
    const services = body.split(/^ {2}(?=trawlarr-node)/m).slice(1);
    expect(services).toHaveLength(2);
    for (const service of services) {
      expect(service).toMatch(/^\s+healthcheck:\s*\n\s+disable:\s+true\b/m);
    }
  });

  it('selects node mode', () => {
    expect(body).toMatch(/TRAWLARR_MODE=node/);
  });

  it('gives the daemon time to drain agents on shutdown', () => {
    expect(body).toMatch(/^\s+stop_grace_period:\s+15s\b/m);
  });

  it('offers an NVIDIA profile variant with the encoder capabilities copied over', () => {
    expect(body).toMatch(/trawlarr-node-nvidia/);
    expect(body).toMatch(/runtime:\s+nvidia/);
    expect(body).toMatch(/NVIDIA_VISIBLE_DEVICES=all/);
    expect(body).toMatch(/NVIDIA_DRIVER_CAPABILITIES=[^\n]*video/);
    expect(body).toMatch(/TRAWLARR_HARDWARE=[^\n]*nvenc/);
    expect(body).toMatch(/TRAWLARR_HARDWARE_CAPS=nvenc=\d+/);
  });
});

describe('the NVIDIA variant', () => {
  const body = readFileSync('docker/compose.nvidia.yml', 'utf8');

  it('runs the same image as the CPU compose file', () => {
    // One image, two compose files: a second Dockerfile would be a second
    // thing to keep in step, and Debian's ffmpeg already has the encoders.
    const imageOf = (file: string): string =>
      /^\s+image:\s+(\S+)$/m.exec(readFileSync(file, 'utf8'))![1]!;

    expect(imageOf('docker/compose.nvidia.yml')).toBe(imageOf('docker/compose.yml'));
  });

  it('asks for the GPU, so the declaration it makes can be true', () => {
    expect(body).toMatch(/^\s+runtime:\s+nvidia$/m);
    expect(body).toMatch(/NVIDIA_VISIBLE_DEVICES=all/);
  });

  it('requests the "video" driver capability, without which NVENC is absent', () => {
    // The single most likely way to get this wrong: the runtime's default is
    // compute,utility, which injects CUDA but NOT libnvidia-encode, and
    // hevc_nvenc is then listed by ffmpeg and fails on every job.
    const caps = /NVIDIA_DRIVER_CAPABILITIES=(\S+)/.exec(body)![1]!.split(',');

    expect(caps).toContain('video');
  });

  it('declares nvenc and a session cap, because a card fails jobs past its limit', () => {
    expect(/TRAWLARR_HARDWARE=(\S+)/.exec(body)![1]!.split(',')).toContain('nvenc');
    expect(body).toMatch(/TRAWLARR_HARDWARE_CAPS=nvenc=\d+/);
  });
});

describe('the cluster test fixture', () => {
  const cluster = readFileSync(CLUSTER_FIXTURE, 'utf8');

  it('is the only compose file that runs the daemon with NODE_ENV=test', () => {
    // NODE_ENV=test is what lets TRAWLARR_TEST_ALLOW_SHORT_GRACE lower the
    // lease grace floor. In a deployment file that would let a setting cut
    // the window a disconnected node has to a few seconds.
    expect(cluster).toMatch(/^\s*- NODE_ENV=test$/m);
    for (const file of composeFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/NODE_ENV=test/);
    }
  });

  it('never builds or pulls: it runs the image the harness was given', () => {
    expect(cluster).not.toMatch(/^\s*build:/m);
    expect(cluster.match(/pull_policy: never/g)).toHaveLength(2);
    expect(
      cluster.match(/image: \$\{TRAWLARR_CLUSTER_IMAGE:-trawlarr-cluster:dev\}/g),
    ).toHaveLength(2);
  });

  it('gives no node the server staging volume', () => {
    // Scenario 3 depends on it: a staging directory on the server's own disk
    // must be a path a node cannot reach.
    const nodeService = cluster.slice(cluster.indexOf('\n  node:'));
    expect(nodeService).not.toContain('server-staging:/');
  });

  it('says at the top that it is not a deployment example', () => {
    expect(cluster.split('\n')[0]).toBe(
      '# TEST FIXTURE. Not a deployment example: see compose.node.yml.',
    );
  });
});
