import { useState, type FormEvent, type ReactNode } from 'react';
import { oidcStartUrl } from '../api/session.js';
import { BrandMark } from './BrandMark.js';
import type { AuthState } from './useAuth.js';

/**
 * Where the operator signs in: first-run setup, username/password, or SSO.
 *
 * The session is a cookie the daemon sets, `httpOnly` and unreadable from
 * this page's own JavaScript — unlike the old pasted API key, there is
 * nothing here for devtools or an on-page script to read out. That is the
 * trade this makes deliberately: the browser now has ambient authority for
 * this origin (the cookie rides along on every request without this code
 * doing anything), which is exactly what the API key's design avoided; in
 * exchange, credentials are no longer sitting in `localStorage` in the
 * clear. Machine clients (the CLI, scripts) keep using the API key exactly
 * as before, via `X-Api-Key` — this page never sees or handles that key.
 */
export const AuthGate = (props: { auth: AuthState; children: ReactNode }): JSX.Element => {
  const { auth } = props;

  // Undefined status/account means the initial round trip hasn't answered
  // yet; render nothing rather than flashing a login form that a live
  // session is about to replace.
  if (auth.status === undefined || auth.account === undefined) {
    return <div className="auth-gate auth-gate-loading" aria-busy="true" />;
  }

  if (auth.account !== null) return <>{props.children}</>;

  return auth.status.setupRequired ? (
    <SetupForm auth={auth} />
  ) : (
    <LoginForm auth={auth} oidc={auth.status.oidc} />
  );
};

const SetupForm = (props: { auth: AuthState }): JSX.Element => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await props.auth.setup({ username, password });
    } catch {
      // The error is already surfaced through `auth.error`; nothing further
      // to do here beyond letting the operator try again.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="auth-gate">
      <span className="app-brand">
        <BrandMark />
      </span>
      <h1>Set up trawlarr</h1>
      <p>This daemon has no accounts yet. Create the first one to sign in.</p>
      <label htmlFor="setup-username">Username</label>
      <input
        id="setup-username"
        autoComplete="username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <label htmlFor="setup-password">Password</label>
      <input
        id="setup-password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <p className="hint">At least 8 characters.</p>
      {props.auth.error !== null && (
        <p role="alert" className="problem">
          {props.auth.error}
        </p>
      )}
      <button
        type="submit"
        className="btn-primary"
        disabled={submitting || username === '' || password === ''}
      >
        {submitting ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
};

const LoginForm = (props: {
  auth: AuthState;
  oidc: { displayName: string } | null;
}): JSX.Element => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await props.auth.login({ username, password });
    } catch {
      // Surfaced through `auth.error`; the form stays filled in for a retry.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="auth-gate">
      <span className="app-brand">
        <BrandMark />
      </span>
      <h1>Sign in to trawlarr</h1>
      <label htmlFor="login-username">Username</label>
      <input
        id="login-username"
        autoComplete="username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <label htmlFor="login-password">Password</label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {props.auth.error !== null && (
        <p role="alert" className="problem">
          {props.auth.error}
        </p>
      )}
      <button
        type="submit"
        className="btn-primary"
        disabled={submitting || username === '' || password === ''}
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
      {props.oidc !== null && (
        <a
          className="oidc-button"
          href={oidcStartUrl({
            returnTo:
              (globalThis as { location?: { pathname?: string } }).location?.pathname ?? '/',
          })}
        >
          Sign in with {props.oidc.displayName}
        </a>
      )}
    </form>
  );
};
