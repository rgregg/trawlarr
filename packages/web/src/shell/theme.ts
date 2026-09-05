/**
 * Theme choice, as pure functions over a stored string.
 *
 * There are THREE choices, not two: a viewer who has never touched the
 * control follows their system, and "follow the system" has to survive as a
 * distinct state or the first click permanently opts them out of it. The
 * stylesheet mirrors the same three states (`:root`, the
 * `prefers-color-scheme` query, and `[data-theme]`), so what is stored here
 * and what CSS reads are the same vocabulary.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'trawlarr.theme';

/**
 * Anything else in storage — a value from a future version, or a key some
 * other app on the same origin wrote — falls back to `system` rather than
 * throwing. A bad byte in localStorage must not be able to stop the app
 * from rendering.
 */
export const readThemeChoice = (raw: string | null): ThemeChoice =>
  raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';

/**
 * The cycle order the single toggle button walks. It starts from where the
 * viewer already is: from `system` the next state is the OPPOSITE of what
 * they are currently seeing, so one click always visibly changes something.
 * A cycle that could begin with a no-op reads as a broken button.
 */
export const nextThemeChoice = (current: ThemeChoice, systemPrefersDark: boolean): ThemeChoice => {
  if (current === 'system') return systemPrefersDark ? 'light' : 'dark';
  if (current === (systemPrefersDark ? 'light' : 'dark'))
    return systemPrefersDark ? 'dark' : 'light';
  return 'system';
};

/** What the viewer actually sees, once the system preference is folded in. */
export const effectiveTheme = (
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): 'light' | 'dark' => (choice === 'system' ? (systemPrefersDark ? 'dark' : 'light') : choice);

export const themeLabel = (choice: ThemeChoice): string =>
  choice === 'system' ? 'Matching your system' : choice === 'dark' ? 'Dark' : 'Light';
