const STORAGE_KEY = 'trawlarr.apiKey';

/**
 * The three methods of `localStorage` this needs, declared STRUCTURALLY
 * rather than as `Pick<Storage, ...>`.
 *
 * `Storage` is a DOM type, and these files are typechecked by the root
 * `tsconfig.typecheck.json` (lib ES2023, types node) so that `pnpm test`
 * covers them in the single gate. A DOM type here would break that pass —
 * and a shape this small is more honest anyway: it says exactly what the
 * store touches, and `localStorage` satisfies it without being named.
 */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KeyStore {
  read(): string | null;
  write(key: string): void;
  clear(): void;
}

/**
 * Where the browser keeps the API key it was given.
 *
 * `localStorage` rather than a cookie: a cookie would be sent automatically
 * by every request the browser makes to this origin, which is precisely the
 * ambient authority the API's security model does not have and does not want.
 * The operator pastes the key once; "Sign out" is `clear()`.
 *
 * What this DOES protect against: a hostile cross-origin page, which cannot
 * read this origin's `localStorage` and cannot cause the browser to attach
 * the key to a request of its own — there is no CSRF shape here.
 *
 * What it does NOT protect against, stated plainly: anyone with access to
 * the same browser profile. The key survives closing the tab, it is readable
 * from the devtools console, and any script that manages to run on this
 * origin can read it — so an XSS on this origin is a key disclosure, not
 * merely a session hijack. On a shared or unattended browser, "Sign out" is
 * the only thing that removes it. That is the same exposure as leaving the
 * key in a shell history or a script on disk, which is the bar this design
 * deliberately holds itself to: the UI is a client with the operator's key,
 * no more privileged and no better protected than `curl`.
 *
 * The storage is INJECTED rather than reached for, so the behaviour is
 * testable without a DOM and a future task can swap `sessionStorage` in
 * without touching a caller.
 */
export const createKeyStore = (storage: KeyStorage): KeyStore => ({
  read: () => {
    const value = storage.getItem(STORAGE_KEY);
    return value === null || value === '' ? null : value;
  },
  write: (key) => {
    storage.setItem(STORAGE_KEY, key);
  },
  clear: () => {
    storage.removeItem(STORAGE_KEY);
  },
});
