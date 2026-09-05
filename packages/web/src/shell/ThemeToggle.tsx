import { useEffect, useState } from 'react';

import {
  effectiveTheme,
  nextThemeChoice,
  readThemeChoice,
  themeLabel,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from './theme.js';

/**
 * The theme control, and the state behind it.
 *
 * The choice is written to `documentElement`'s `data-theme` and to
 * `localStorage`; `index.html` reads the same key in a tiny inline script
 * before first paint so a dark-theme viewer never sees a white flash. THE
 * TWO PLACES THAT READ THAT KEY MUST AGREE — the vocabulary is fixed in
 * `theme.ts`, and the inline script deliberately does nothing clever with a
 * value it does not recognise.
 *
 * `system` writes NO attribute at all, which is what hands control back to
 * the `prefers-color-scheme` query in `tokens.css`.
 */
const applyChoice = (choice: ThemeChoice): void => {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
};

const SunIcon = (): JSX.Element => (
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.2M12 19.2v2.2M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.4 19.6 6 18M18 6l1.6-1.6" />
  </>
);

const MoonIcon = (): JSX.Element => (
  <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" />
);

/* Half filled, half outlined: "whatever the system says". */
const SystemIcon = (): JSX.Element => (
  <>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 3.6a8.4 8.4 0 0 1 0 16.8Z" fill="currentColor" stroke="none" />
  </>
);

export const ThemeToggle = (): JSX.Element => {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    readThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    applyChoice(choice);
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  }, [choice]);

  // While the choice is `system`, the button's own icon and label have to
  // change when the OS flips at sunset — the CSS follows on its own, but
  // this component would otherwise keep offering the wrong next state.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      setSystemPrefersDark(query.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  const showing = effectiveTheme(choice, systemPrefersDark);
  const next = nextThemeChoice(choice, systemPrefersDark);

  return (
    <button
      type="button"
      className="theme-toggle"
      // The label states BOTH the current setting and what the click does.
      // An icon-only control with a one-word label ("Theme") tells a screen
      // reader user nothing about which way they are about to go.
      aria-label={`Theme: ${themeLabel(choice)}. Switch to ${themeLabel(next).toLowerCase()}`}
      title={`Theme: ${themeLabel(choice)}`}
      onClick={() => {
        setChoice(next);
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        {choice === 'system' ? <SystemIcon /> : showing === 'dark' ? <MoonIcon /> : <SunIcon />}
      </svg>
    </button>
  );
};
