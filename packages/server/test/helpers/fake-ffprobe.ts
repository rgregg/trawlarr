import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The document the fake prints for every file it is asked about.
 *
 * Exported as well as spawned, so a test that injects `probeFileImpl` (the
 * in-process probe seam) and a test that points `ffprobePath` at the script
 * are talking about the same probe rather than two documents that drift.
 *
 * Deliberately a plausible, complete probe — one h264 video stream, one aac
 * audio stream, and a `format` block with a duration, a size and a bitrate —
 * because `extractFacts` reads all of those and a scan whose facts came back
 * half-empty would exercise a different path through `persist` than a real
 * library does.
 */
export const FAKE_PROBE_DOCUMENT = {
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      r_frame_rate: '24000/1001',
    },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
  ],
  format: { format_name: 'matroska,webm', duration: '120.0', size: '1024', bit_rate: '68' },
};

let cached: string | null = null;

/**
 * Path to an executable that answers every probe with a fixed document.
 *
 * Real ffprobe at five thousand files is a benchmark of ffprobe, not of the
 * scanner — and the scanner is what spec §3.3 and §4.1 make promises about.
 * The suites that need to know trawlarr can read a real container use real
 * media and real ffprobe (`scan-library.test.ts`, the end-to-end suites);
 * this exists for the suites that need SCALE, where per-file decode cost
 * would be the only thing measured.
 *
 * Written once per process and reused: five thousand calls must not be five
 * thousand temp directories.
 */
export const fakeFfprobe = (): string => {
  if (cached !== null) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-fake-ffprobe-'));
  const path = join(dir, 'ffprobe');
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(FAKE_PROBE_DOCUMENT)}\nJSON\n`);
  chmodSync(path, 0o755);
  cached = path;
  return path;
};
