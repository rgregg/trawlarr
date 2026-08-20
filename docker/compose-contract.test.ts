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
]);

const composeFiles = readdirSync('docker')
  .filter((name) => name.startsWith('compose') && name.endsWith('.yml'))
  .map((name) => join('docker', name));

describe('compose files', () => {
  it('are all discovered (a renamed file must not make this suite vacuous)', () => {
    expect(composeFiles).toContain('docker/compose.yml');
    expect(composeFiles).toContain('docker/compose.nvidia.yml');
  });

  it.each(composeFiles)('%s sets only variables trawlarr reads', (file) => {
    const known = new Set([...ENV_BINDINGS.map((binding) => binding.name), ...RUNTIME_VARS]);
    const body = readFileSync(file, 'utf8');
    // The `environment:` block is a YAML list of `- NAME=value` entries.
    const declared = [...body.matchAll(/^\s+-\s+([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !known.has(name))).toEqual([]);
  });

  it('publish the daemon port the image binds', () => {
    for (const file of composeFiles) {
      expect(readFileSync(file, 'utf8')).toContain('8265');
    }
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
