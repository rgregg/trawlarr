import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARDWARE_TYPES, type HardwareType } from '@trawlarr/core';

const run = promisify(execFile);

export interface HardwareFinding {
  hardwareType: HardwareType;
  expectedEncoder: string;
  present: boolean;
}

/**
 * The HEVC encoder each hardware type must be able to name. One encoder per
 * type is enough: a build with `hevc_nvenc` has the NVENC support trawlarr's
 * flows ask for, and a build without it has none of it.
 */
export const REQUIRED_ENCODER: Record<HardwareType, string | null> = {
  cpu: null,
  nvenc: 'hevc_nvenc',
  qsv: 'hevc_qsv',
  vaapi: 'hevc_vaapi',
  videotoolbox: 'hevc_videotoolbox',
  amf: 'hevc_amf',
};

/**
 * How to make this hardware type encode ONE frame, or `null` when there is no
 * way to ask without guessing at a device.
 *
 * This table is the reason the preflight catches anything at all. Debian's
 * ffmpeg lists `hevc_nvenc` in `-encoders` on a machine with no GPU, no
 * driver and no `/dev/nvidia*` whatsoever — the encoder is compiled against
 * headers and loads `libcuda.so.1`/`libnvidia-encode.so.1` at RUN time. So
 * the listing check alone answers "was NVENC compiled in", which for the
 * deployment this exists for is always yes, and never answers the question
 * the operator actually has. Encoding one 64×64 frame to `null` costs about
 * half a second and answers it.
 *
 * `vaapi` and `qsv` are deliberately `null`. Neither can encode a
 * system-memory frame without being told which render node to use
 * (`-init_hw_device vaapi=…:/dev/dri/renderD128` plus a `hwupload` filter
 * chain), and picking a device node for the operator would be detection —
 * the thing this file exists to not do. Worse, a naive probe for them fails
 * on a machine where the declaration is perfectly correct, which would train
 * an operator to ignore the one warning that matters. `videotoolbox` and
 * `amf` are `null` for the weaker reason that no one has verified a
 * device-free probe for them on real hardware; a check nobody has seen pass
 * is not a check.
 */
export const FUNCTIONAL_PROBE: Record<HardwareType, readonly string[] | null> = {
  cpu: null,
  nvenc: ['-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.04', '-c:v', 'hevc_nvenc', '-f', 'null', '-'],
  qsv: null,
  vaapi: null,
  videotoolbox: null,
  amf: null,
};

/** `ffmpeg -encoders` output, reduced to the encoder names it lists. */
export const listEncodersWith = async (ffmpegPath: string): Promise<string[]> => {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-encoders'], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
  });
  // The six flag columns ffmpeg prints before each name (`V....D`), anchored
  // so that the legend above the rule — which has the same shape followed by
  // `=` — contributes nothing.
  return [...stdout.matchAll(/^\s*[VAS][F.][S.][X.][B.][D.]\s+([A-Za-z0-9_-]+)\s/gm)].map(
    (match) => match[1]!,
  );
};

/**
 * Can this ffmpeg really encode with the declared hardware, right now, on
 * this machine?
 *
 * One frame, 64×64, from `lavfi` to `-f null` — it reads nothing and writes
 * nothing, so it is safe to run at start with the library mounted read-only
 * or not mounted at all. A failure is an answer, not an error: a missing
 * driver, a device that was not passed through, or an NVENC session limit
 * already reached all land here as `false`.
 *
 * A type with no entry in {@link FUNCTIONAL_PROBE} answers `false` WITHOUT
 * running anything, and the caller — `preflightHardware` — never asks about
 * one. The two are kept consistent by that table rather than by a second
 * list.
 */
export const probeEncoderWith = async (
  ffmpegPath: string,
  hardwareType: HardwareType,
): Promise<boolean> => {
  const probe = FUNCTIONAL_PROBE[hardwareType];
  if (probe === null) return false;
  try {
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...probe], {
      // Bounded, because this runs before the API is listening: an ffmpeg
      // that hangs on a wedged device must not hang the daemon's start.
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Check a DECLARATION, never replace one.
 *
 * Trawlarr does not detect hardware — an operator says what this node has,
 * and a wrong answer produces failing jobs. This exists because the most
 * common way to be wrong is invisible: the NVIDIA container runtime injects
 * the encoder library only when NVIDIA_DRIVER_CAPABILITIES includes `video`,
 * and its default does not. A finding names that once at start instead of
 * once per file for ever.
 *
 * It reports, and reports only. `hardware.available` is not edited, no
 * library is paused, and no job is routed differently — a node whose GPU is
 * merely busy at start would otherwise disable itself for the whole run, and
 * a pause is cluster-wide state written from one node's local answer.
 *
 * TWO STAGES, in order, both of them about the declaration:
 *  1. Does this ffmpeg BUILD name the encoder at all? (Debian's does.)
 *  2. Can it encode one frame with it right now? (Only where asking that
 *     needs no guess about a device — see {@link FUNCTIONAL_PROBE}.)
 *
 * An ffmpeg that cannot be asked yields `present: false`, deliberately: "we
 * could not check" must not be reported as "checked and fine".
 */
export const preflightHardware = async (input: {
  available: HardwareType[];
  listEncoders: () => Promise<string[]>;
  /** Runs one frame through the type's encoder. Omitted, only stage 1 runs. */
  tryEncode?: (hardwareType: HardwareType) => Promise<boolean>;
}): Promise<HardwareFinding[]> => {
  const wanted = input.available
    .filter((type) => REQUIRED_ENCODER[type] !== null)
    .map((type) => ({ hardwareType: type, expectedEncoder: REQUIRED_ENCODER[type]! }));
  if (wanted.length === 0) return [];

  let encoders: string[];
  try {
    encoders = await input.listEncoders();
  } catch {
    encoders = [];
  }
  const listed = new Set(encoders);

  const findings: HardwareFinding[] = [];
  for (const entry of wanted) {
    if (!listed.has(entry.expectedEncoder)) {
      findings.push({ ...entry, present: false });
      continue;
    }
    const tryEncode = input.tryEncode;
    if (tryEncode === undefined || FUNCTIONAL_PROBE[entry.hardwareType] === null) continue;
    let works: boolean;
    try {
      works = await tryEncode(entry.hardwareType);
    } catch {
      // Same rule as stage 1: a probe that could not be run is not a pass.
      works = false;
    }
    if (!works) findings.push({ ...entry, present: false });
  }

  return findings.sort(
    (a, b) => HARDWARE_TYPES.indexOf(a.hardwareType) - HARDWARE_TYPES.indexOf(b.hardwareType),
  );
};
