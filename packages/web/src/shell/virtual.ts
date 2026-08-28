/**
 * Which slice of a long list is worth rendering.
 *
 * A library is 4,625 rows today and nothing says the next one is smaller, so
 * the table renders a window and pads it with two spacer rows. Pure, because
 * the arithmetic — not the scrolling — is what breaks.
 */
export const visibleRange = (input: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}): { start: number; end: number } => {
  const overscan = input.overscan ?? 6;
  if (input.count <= 0 || input.rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(input.scrollTop / input.rowHeight) - overscan;
  const visible = Math.ceil(input.viewportHeight / input.rowHeight) + overscan * 2;
  const start = Math.max(0, first);
  return { start, end: Math.min(input.count, start + visible) };
};
