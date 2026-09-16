/**
 * An "excerpt" that grows without bound is not one: a chatty community
 * plugin (or one that echoes ffmpeg's own progress lines through `jobLog`)
 * can write megabytes into a single step. Kept generous — several full
 * pages of log text — because the trace exists to answer "why did this file
 * get this decision", and a truncation aggressive enough to cut off the
 * actual error message defeats that.
 */
export const MAX_LOG_EXCERPT_CHARS = 8_000;

export const truncateLogExcerpt = (text: string): string => {
  if (text.length <= MAX_LOG_EXCERPT_CHARS) return text;
  const kept = text.slice(0, MAX_LOG_EXCERPT_CHARS);
  const omitted = text.length - MAX_LOG_EXCERPT_CHARS;
  return `${kept}\n… [truncated, ${omitted} more characters]`;
};
