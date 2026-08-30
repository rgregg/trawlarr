import { useCallback, useEffect, useState } from 'react';
import { parseRoute, type Route } from './route.js';

/**
 * The three things this hook touches on `window`, declared STRUCTURALLY
 * rather than via the ambient DOM lib.
 *
 * This file is `.ts`, not `.tsx`, so it is one of the sources the root
 * typecheck config (`tsconfig.typecheck.json`, no `"DOM"` in `lib`) walks
 * alongside the server and engine packages — see `useApi.ts` and
 * `useLive.ts` for the same shape. `globalThis` is what stays valid there;
 * a bare reference to `window` would not.
 */
interface RouteWindow {
  location: { pathname: string; search: string };
  addEventListener: (type: 'popstate', listener: () => void) => void;
  removeEventListener: (type: 'popstate', listener: () => void) => void;
  history: {
    pushState: (data: unknown, unused: string, url: string) => void;
    replaceState: (data: unknown, unused: string, url: string) => void;
  };
}

const browserWindow = (): RouteWindow => {
  const win = (globalThis as { window?: RouteWindow }).window;
  if (win === undefined) {
    throw new Error('useRoute() needs a browser window. There is none on this globalThis.');
  }
  return win;
};

/**
 * The History API, read the same way on every render.
 *
 * No routing library: the whole route table is seven patterns, and a library
 * would be more code than `route.ts`. `popstate` covers the back button;
 * `navigate` covers everything else.
 */
export const useRoute = (): { route: Route; navigate: (to: string) => void } => {
  const win = browserWindow();
  const read = (): Route => parseRoute(win.location.pathname, win.location.search);
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onPop = (): void => {
      setRoute(read());
    };
    win.addEventListener('popstate', onPop);
    return () => {
      win.removeEventListener('popstate', onPop);
    };
  }, [win]);

  const navigate = useCallback(
    (to: string): void => {
      // NAVIGATING TO WHERE YOU ALREADY ARE REPLACES, IT DOES NOT PUSH.
      // Every nav entry is a `<Link>` that calls this, so clicking "Files"
      // while already on Files used to stack another identical entry — and
      // three idle clicks made Back appear broken, because the first three
      // presses went nowhere visible. Compared against the URL the browser
      // currently shows rather than against `route`, since that is the
      // entry that would be duplicated.
      const current = `${win.location.pathname}${win.location.search}`;
      if (to === current) {
        win.history.replaceState(null, '', to);
      } else {
        win.history.pushState(null, '', to);
      }
      setRoute(parseRoute(win.location.pathname, win.location.search));
    },
    [win],
  );

  return { route, navigate };
};
