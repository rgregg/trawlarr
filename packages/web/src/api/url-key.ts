import { createApiClient } from './client.js';
import type { KeyStore } from './key.js';

const URL_KEY_PARAM = 'apiKey';

export interface UrlKeyExtraction {
  key: string;
  /** The same URL with `apiKey` removed, ready for `history.replaceState`. */
  strippedHref: string;
}

/**
 * Reads `?apiKey=…` off a page URL, structurally — see `pageUrl()` in
 * `client.ts` for why the browser global is never read from in here.
 *
 * An empty value is treated the same as an absent one, matching
 * `createKeyStore().read()`: `?apiKey=` with nothing after the `=` is not a
 * key anyone typed on purpose.
 */
export const extractUrlKey = (href: string): UrlKeyExtraction | null => {
  const url = new URL(href);
  const key = url.searchParams.get(URL_KEY_PARAM);
  if (key === null || key === '') return null;
  url.searchParams.delete(URL_KEY_PARAM);
  return { key, strippedHref: url.toString() };
};

/**
 * The three methods of `History` this needs, declared structurally for the
 * same reason `KeyStorage` is: it keeps this module typecheckable under the
 * ES2023-lib gate `pnpm test` runs, and it says exactly what gets touched.
 */
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type UrlKeyBootstrapResult =
  { apiKey: string; problem: null } | { apiKey: null; problem: string };

/**
 * What happens when the page loads with a key on the URL.
 *
 * THE URL PARAMETER IS STRIPPED UNCONDITIONALLY, before the key is even
 * looked at: a bookmarked link is meant to be reusable, so the key it
 * carries must not become a second, permanent copy sitting in the address
 * bar, the history list, or a synced-bookmarks payload the moment it is
 * used.
 *
 * AN ALREADY-STORED KEY WINS over one arriving on the URL, without even
 * verifying the URL one. The bookmarkable link exists for the "no key yet
 * on this device" case; a device that is already signed in has nothing to
 * gain from a URL silently replacing its working key, and something to
 * lose — a stale bookmark (or a link someone else sent, pointing at a key
 * that has since been rotated or was never the operator's own) would
 * otherwise be able to sign the browser out of a session that was working
 * fine, or quietly switch it to a different key. Stripping still happens
 * either way, because the address bar is not a safe place for the old key
 * to sit even when it is not going to be used.
 *
 * A bad key on the URL falls through to the gate with a stated reason,
 * never a blank screen: `problem` is exactly the sentence `KeyGate` shows.
 */
export const bootstrapFromUrl = async (input: {
  href: string;
  store: KeyStore;
  history: HistoryLike;
  verify: (key: string) => Promise<void>;
}): Promise<UrlKeyBootstrapResult | null> => {
  const extracted = extractUrlKey(input.href);
  if (extracted === null) return null;

  input.history.replaceState(null, '', extracted.strippedHref);

  const stored = input.store.read();
  if (stored !== null) return { apiKey: stored, problem: null };

  try {
    await input.verify(extracted.key);
  } catch {
    return { apiKey: null, problem: 'The key in that link was not accepted.' };
  }
  input.store.write(extracted.key);
  return { apiKey: extracted.key, problem: null };
};

/**
 * The verification `bootstrapFromUrl` runs: the same request `KeyGate` makes
 * before storing a pasted key, against the same endpoint, so a key good
 * enough for one is good enough for the other.
 */
export const verifyKeyAgainstServer = async (key: string): Promise<void> => {
  await createApiClient({ apiKey: key }).get('/system/version');
};
