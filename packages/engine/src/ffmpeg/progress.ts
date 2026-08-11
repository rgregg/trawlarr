export interface FfmpegProgress {
  outTimeMs: number | null;
  frame: number | null;
  fps: number | null;
  speed: number | null;
  done: boolean;
}

/** `-y` overwrites the staged output, which is ours and always safe to replace. */
export const PROGRESS_ARGS = ['-progress', 'pipe:1', '-nostats', '-hide_banner', '-y'] as const;

const numberOf = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === 'N/A') return null;
  const parsed = Number.parseFloat(raw.replace(/x$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Parse ffmpeg's `-progress` stream. It emits `key=value` lines terminated by
 * a `progress=` line, and chunk boundaries fall anywhere, so partial lines
 * are buffered until complete.
 */
export const createProgressParser = (): { push(chunk: string): FfmpegProgress[] } => {
  let buffer = '';
  let fields: Record<string, string> = {};

  return {
    push(chunk) {
      buffer += chunk;
      const updates: FfmpegProgress[] = [];

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (line === '') continue;
        const separator = line.indexOf('=');
        if (separator === -1) continue;

        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        fields[key] = value;

        if (key === 'progress') {
          const microseconds = numberOf(fields.out_time_ms);
          updates.push({
            frame: numberOf(fields.frame),
            fps: numberOf(fields.fps),
            outTimeMs: microseconds === null ? null : Math.round(microseconds / 1000),
            speed: numberOf(fields.speed),
            done: value === 'end',
          });
          fields = {};
        }
      }

      return updates;
    },
  };
};
