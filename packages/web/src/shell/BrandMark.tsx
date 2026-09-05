/**
 * The mark: a sounder ping — a transducer and three returns, fading as they
 * spread. It is what a trawler actually watches to know what is under it,
 * and it says the same thing this product does: send something out over the
 * whole library, and read back what is there.
 *
 * `currentColor` throughout, so it takes the accent in both themes without
 * a second asset. Inline rather than a file: one request fewer, and an
 * `<img>` could not follow the theme.
 */
export const BrandMark = (): JSX.Element => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="4.5" r="1.6" fill="currentColor" stroke="none" />
    <path d="M8 4.5 A4 4 0 0 0 16 4.5" />
    <path d="M5 4.5 A7 7 0 0 0 19 4.5" opacity="0.6" />
    <path d="M2 4.5 A10 10 0 0 0 22 4.5" opacity="0.3" />
  </svg>
);
