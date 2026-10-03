/**
 * Waits for a condition about observable state. The deadline only turns a
 * hang into a message naming what was awaited and what was seen instead.
 */
export const until = async (
  what: string,
  predicate: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    describe?: () => string | Promise<string>;
  } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      const detail =
        options.describe === undefined ? '' : `\nLast seen: ${await options.describe()}`;
      throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for: ${what}.${detail}\n` +
          `(The deadline is a hang detector, not an expectation about speed.)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
  }
};
