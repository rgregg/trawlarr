import { useEffect, useState } from 'react';

/**
 * A CSS media query, read from JavaScript.
 *
 * Two things on this branch need to know about the SAME breakpoint the sheet
 * uses at `48rem`, because at that width the layout does something the
 * component cannot infer from props:
 *
 *  - `Files.tsx` windows its rows on a fixed row height, and below `48rem`
 *    `.file-row` stops being a grid row and becomes a stacked card several
 *    times taller. A window computed with the desktop height there asks for
 *    six times the rows that fit and mis-sizes both spacers, so the
 *    scrollbar and the scroll position disagree with the content by ~3x.
 *  - `App.tsx` mounts the Files table BEHIND the file detail panel on
 *    desktop; below `48rem` the sheet sets `display: none` on it, so
 *    mounting it there pages an entire library (24 sequential requests on
 *    4,625 files) to render nothing at all.
 *
 * THE BREAKPOINT IS DUPLICATED, in `styles.css` and in `FILES_NARROW`
 * below, and there is no way around that without a build step to share it.
 * It is one constant, exported from one place, and both callers import it
 * from here rather than each writing `48rem` themselves.
 *
 * Declared structurally off `globalThis`, like `useRoute.ts`/`useApi.ts`:
 * this is a `.ts` file, so it is typechecked by the root config with no
 * `"DOM"` in `lib`. `matchMedia` missing (or an older `MediaQueryList` with
 * no `addEventListener`) is not an error — the hook simply reports `false`
 * and never updates, which is the desktop layout, the safe default for a
 * server render or a test.
 */
interface MediaQueryListLike {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

/** The one breakpoint `styles.css` narrows the Files table at. */
export const FILES_NARROW = '(max-width: 48rem)';

const matchMedia = (query: string): MediaQueryListLike | null => {
  const fn = (globalThis as { matchMedia?: (query: string) => MediaQueryListLike }).matchMedia;
  return fn === undefined ? null : fn.call(globalThis, query);
};

export const useMedia = (query: string): boolean => {
  const [matches, setMatches] = useState<boolean>(() => matchMedia(query)?.matches ?? false);

  useEffect(() => {
    const list = matchMedia(query);
    if (list === null) return;
    setMatches(list.matches);
    const onChange = (): void => {
      setMatches(list.matches);
    };
    list.addEventListener?.('change', onChange);
    return () => {
      list.removeEventListener?.('change', onChange);
    };
  }, [query]);

  return matches;
};
