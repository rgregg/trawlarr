import type { ProbeData, ProbeStream } from '@trawlarr/plugin-api';

/**
 * Set Video Encoder's bitrate cap: never let an encode's video bitrate exceed
 * a percentage of the source's.
 *
 * A quality target like `-cq 23` is a fixed bar, not a relative one. A web
 * release encoded below that bar comes out BIGGER when re-encoded to meet it —
 * on the production library thirty episodes grew by 1% to 193%, from 1.65 Mbps
 * MPEG-4 to 8.6 Mbps H.264, so no bitrate threshold separated them from files
 * that shrink — and the size gate in Replace Original File then discards each
 * encode, which a flow edit re-queues to be thrown away again. A cap keeps the
 * quality target but stops the encode spending more than the source did.
 * Measured on the production GPU and in software: hevc_nvenc and libx265 both
 * honour `-maxrate`/`-bufsize` in constant-quality mode, landing within about
 * 1% of the cap over a real running time.
 */

/** Megabytes cross the plugin boundary in decimal (`file_size`); see `file-object.ts`. */
const BYTES_PER_DECIMAL_MEGABYTE = 1_000_000;

const positiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const isCoverArt = (stream: ProbeStream): boolean =>
  Number((stream.disposition as Record<string, unknown> | undefined)?.attached_pic ?? 0) === 1;

/** A stream's own bitrate, from the numeric field or Matroska's statistics tag. */
const streamBitrate = (stream: ProbeStream): number | null => {
  const tags = stream.tags as Record<string, unknown> | undefined;
  return (
    positiveNumber(stream.bit_rate) ??
    positiveNumber(tags?.BPS) ??
    positiveNumber(tags?.['BPS-eng'])
  );
};

export interface SourceVideoBitrate {
  bitsPerSecond: number;
  /** How the number was reached, for the job log. */
  basis: string;
}

/**
 * The source's VIDEO bitrate: the whole file's bitrate minus every other
 * stream's.
 *
 * Deliberately never the video stream's own tag. Matroska's `BPS` statistics
 * tag is written once and survives later remuxes, so it can describe a video
 * track that no longer exists: on the production library an AV1 episode's tag
 * claimed 4.59 Mbps in a file whose whole bitrate is 1.91. The whole-file
 * bitrate is the one number the container measures from what it holds, and
 * audio and subtitle tags are small enough that a stale one barely moves the
 * result. Where the two agree — a freshly muxed file — this lands within a
 * few hundred bits of the tag.
 *
 * `fileSizeMb` is the plugin contract's `file_size`, used only when the
 * container reports no overall bitrate.
 */
export const sourceVideoBitrate = (
  probe: ProbeData,
  fileSizeMb: number,
): SourceVideoBitrate | null => {
  const streams = probe.streams ?? [];
  const format = probe.format as Record<string, unknown> | undefined;

  let total = positiveNumber(format?.bit_rate);
  let basis = "the container's overall bitrate";
  if (total === null) {
    const seconds = positiveNumber(format?.duration);
    if (seconds === null || fileSizeMb <= 0) return null;
    total = Math.round((fileSizeMb * BYTES_PER_DECIMAL_MEGABYTE * 8) / seconds);
    basis = 'file size over duration';
  }

  const others = streams
    .filter((stream) => stream.codec_type !== 'video' && !isCoverArt(stream))
    .reduce((sum, stream) => sum + (streamBitrate(stream) ?? 0), 0);

  // Tags that claim the other streams hold more than the whole file are
  // nonsense, and subtracting them would cap an encode at zero.
  if (others >= total) {
    return { bitsPerSecond: total, basis: `${basis} (other streams' tags ignored as implausible)` };
  }
  return { bitsPerSecond: total - others, basis: `${basis}, less the other streams` };
};

/** Reads the node input: empty means no cap; otherwise a whole percentage from 1 to 100. */
export const bitrateCapPercentFrom = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const percent = Number(text);
  // Not above 100: a cap above the source no longer stops an encode
  // outgrowing it, which is the only thing this is for.
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error(
      `Bitrate cap must be a whole percentage from 1 to 100, got "${text}". ` +
        'Leave it empty for no cap.',
    );
  }
  return percent;
};
