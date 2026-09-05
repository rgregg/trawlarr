/**
 * Rendering an instant, without the possibility of taking the app down.
 *
 * `Date.prototype.toISOString()` does not degrade for a value it cannot
 * represent — it THROWS `RangeError: Invalid time value`, for NaN and for
 * any magnitude beyond ±8.64e15 ms. In a React render a throw is not a bad
 * cell: it unmounts the entire tree. That is not hypothetical here. A file
 * whose `mtimeMs` was out of range gave the operator a white page with no
 * message, no retry and no way out but editing the URL by hand.
 *
 * Some of the timestamps this UI renders are the daemon's own clock
 * readings and could only be nonsense if the daemon were. Others are not:
 * `mtimeMs` is whatever `fs.stat()` reported about the file, stored verbatim
 * (`mtime_ms INTEGER NOT NULL`, written unvalidated by the scanner), so a
 * share that reports a nonsense inode timestamp puts a nonsense number
 * straight into the row and the API hands it over typed as a `number`.
 *
 * Rather than ask each call site to know which kind it is holding — the
 * question that was got wrong once already — everything that renders an
 * instant comes through here.
 */

/**
 * The largest magnitude a `Date` can represent, in milliseconds. ECMA-262
 * fixes it at ±100,000,000 days, so this is a constant, not a guess.
 */
const MAX_TIME_VALUE = 8.64e15;

/**
 * The instant as an ISO 8601 string, or `null` when there isn't one.
 *
 * `null` rather than a placeholder, because some callers need the string
 * itself — `formatWhen` in `flow-version-model.ts` slices a day and a time
 * out of it — and a caller that has to detect "no instant" by comparing
 * against a display string is a caller waiting to be broken by a change to
 * that string.
 *
 * Zero and negative read as unset rather than as 1970 and 1969: that is what
 * an absent timestamp looks like in this schema, and a media file predating
 * the epoch does not exist.
 */
export const toIsoInstant = (ms: number): string | null => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms <= 0 || Math.abs(ms) > MAX_TIME_VALUE) return null;
  return new Date(ms).toISOString();
};

/** The instant in full, or an em dash. For a screen with room for one. */
export const formatTimestamp = (ms: number): string => toIsoInstant(ms) ?? '—';
