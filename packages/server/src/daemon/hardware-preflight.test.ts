import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARDWARE_TYPES, type HardwareType } from '@trawlarr/core';
import {
  FUNCTIONAL_PROBE,
  listEncodersWith,
  preflightHardware,
  probeEncoderWith,
  REQUIRED_ENCODER,
} from './hardware-preflight.js';

/** A stand-in `ffmpeg`: a script that prints what a test wants and exits how it says. */
const fakeFfmpeg = (input: { stdout?: string; exitCode?: number; argsFile?: string }): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-fake-ffmpeg-'));
  const path = join(dir, 'ffmpeg');
  const record = input.argsFile === undefined ? '' : `printf '%s\\n' "$@" > ${input.argsFile}\n`;
  writeFileSync(
    path,
    `#!/bin/sh\n${record}cat <<'ENCODERS'\n${input.stdout ?? ''}\nENCODERS\nexit ${String(input.exitCode ?? 0)}\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
};

/** The head of a real `ffmpeg -hide_banner -encoders`, legend and rule included. */
const REAL_ENCODER_OUTPUT = [
  'Encoders:',
  ' V..... = Video',
  ' A..... = Audio',
  ' S..... = Subtitle',
  ' .F.... = Frame-level multithreading',
  ' ..S... = Slice-level multithreading',
  ' ...X.. = Codec is experimental',
  ' ....B. = Supports draw_horiz_band',
  ' .....D = Supports direct rendering method 1',
  ' ------',
  ' V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)',
  ' V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
  ' V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
].join('\n');

describe('preflightHardware', () => {
  it('reports a declared encoder the ffmpeg build does not have', async () => {
    const findings = await preflightHardware({
      available: ['cpu', 'nvenc'],
      listEncoders: async () => ['libx264', 'libx265'],
    });

    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
  });

  it('reports nothing when every declared encoder is present', async () => {
    const findings = await preflightHardware({
      available: ['cpu', 'nvenc'],
      listEncoders: async () => ['libx265', 'hevc_nvenc'],
    });
    expect(findings).toEqual([]);
  });

  it('never reports cpu, which needs no encoder to exist', async () => {
    const findings = await preflightHardware({ available: ['cpu'], listEncoders: async () => [] });
    expect(findings).toEqual([]);
  });

  it('surfaces an ffmpeg that could not be asked as a finding, not a throw', async () => {
    const findings = await preflightHardware({
      available: ['nvenc'],
      listEncoders: async () => {
        throw new Error('spawn ffmpeg ENOENT');
      },
    });
    // "Could not check" must not read as "checked and fine": the daemon still
    // starts, and the finding says the encoder was not shown to be present.
    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
  });

  it('reports an encoder the build lists but this machine cannot actually run', async () => {
    // The case the whole task exists for: Debian's ffmpeg lists `hevc_nvenc`
    // whether or not a driver is there, so listing it proves only that it was
    // compiled in.
    const findings = await preflightHardware({
      available: ['cpu', 'nvenc'],
      listEncoders: async () => ['libx265', 'hevc_nvenc'],
      tryEncode: async () => false,
    });

    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
  });

  it('reports nothing when the declared encoder both lists and runs', async () => {
    const findings = await preflightHardware({
      available: ['nvenc'],
      listEncoders: async () => ['hevc_nvenc'],
      tryEncode: async () => true,
    });
    expect(findings).toEqual([]);
  });

  it('treats a probe that could not be run as not shown to work', async () => {
    const findings = await preflightHardware({
      available: ['nvenc'],
      listEncoders: async () => ['hevc_nvenc'],
      tryEncode: async () => {
        throw new Error('spawn ffmpeg EAGAIN');
      },
    });
    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
  });

  it('does not run — or fail on — a probe for hardware that has no device-free one', async () => {
    // vaapi and qsv cannot be exercised without naming a device node, and
    // guessing one would be detection. Their listing check stands alone;
    // inventing a probe that always fails would report every correct vaapi
    // declaration as broken, which is the noise this is meant to remove.
    const probed: HardwareType[] = [];
    const findings = await preflightHardware({
      available: ['vaapi', 'qsv'],
      listEncoders: async () => ['hevc_vaapi', 'hevc_qsv'],
      tryEncode: async (type) => {
        probed.push(type);
        return false;
      },
    });

    expect(findings).toEqual([]);
    expect(probed).toEqual([]);
  });

  it('orders findings by HARDWARE_TYPES, and reports every declared type that is missing', async () => {
    const findings = await preflightHardware({
      available: ['vaapi', 'nvenc'],
      listEncoders: async () => [],
    });

    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
      { hardwareType: 'vaapi', expectedEncoder: 'hevc_vaapi', present: false },
    ]);
  });
});

describe('the tables', () => {
  it('name an encoder for every hardware type there is', () => {
    // A hardware type added later must be given an answer here deliberately,
    // rather than defaulting to "undefined" and being silently unchecked.
    expect(Object.keys(REQUIRED_ENCODER).sort()).toEqual([...HARDWARE_TYPES].sort());
    expect(Object.keys(FUNCTIONAL_PROBE).sort()).toEqual([...HARDWARE_TYPES].sort());
    expect(REQUIRED_ENCODER.cpu).toBeNull();
    expect(FUNCTIONAL_PROBE.cpu).toBeNull();
  });
});

describe('listEncodersWith', () => {
  it('reads encoder names out of a real -encoders listing, and nothing else', async () => {
    const encoders = await listEncodersWith(fakeFfmpeg({ stdout: REAL_ENCODER_OUTPUT }));

    expect(encoders).toEqual(['a64multi', 'libx264', 'h264_nvenc', 'hevc_nvenc', 'aac']);
  });

  it('asks the configured ffmpeg for its encoders and not for anything else', async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-args-')), 'args');
    await listEncodersWith(fakeFfmpeg({ stdout: REAL_ENCODER_OUTPUT, argsFile }));

    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      '-hide_banner',
      '-encoders',
    ]);
  });

  it('rejects when the binary cannot be run, rather than answering "no encoders"', async () => {
    await expect(listEncodersWith(join(tmpdir(), 'no-such-ffmpeg-a8b3'))).rejects.toThrow();
  });
});

describe('probeEncoderWith', () => {
  it('is false when the one-frame encode fails, which is what a missing driver does', async () => {
    expect(await probeEncoderWith(fakeFfmpeg({ exitCode: 1 }), 'nvenc')).toBe(false);
  });

  it('is true when the one-frame encode succeeds', async () => {
    expect(await probeEncoderWith(fakeFfmpeg({ exitCode: 0 }), 'nvenc')).toBe(true);
  });

  it('encodes one tiny frame with the declared encoder and writes nothing anywhere', async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-args-')), 'args');
    await probeEncoderWith(fakeFfmpeg({ argsFile }), 'nvenc');
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');

    expect(args).toContain('hevc_nvenc');
    expect(args).toContain('null');
    expect(args.filter((arg) => arg.startsWith('/'))).toEqual([]);
  });

  it('is false for a hardware type with no device-free probe, having run nothing', async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-args-')), 'args');
    expect(await probeEncoderWith(fakeFfmpeg({ argsFile }), 'vaapi')).toBe(false);
    expect(() => readFileSync(argsFile, 'utf8')).toThrow();
  });
});
