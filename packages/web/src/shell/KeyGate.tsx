import { useState, type FormEvent, type ReactNode } from 'react';
import { createApiClient } from '../api/client.js';

/**
 * Where the operator pastes the key.
 *
 * THIS IS THE SAME KEY A SHELL SCRIPT USES, and the gate says so, because the
 * UI having no privileged path is a design rule and not an accident: anything
 * this page can do is scriptable with `curl` and the same header. There is no
 * cookie, no session and no login — a cookie would give this origin ambient
 * authority, which is precisely what the event socket's security argument
 * says the API does not have.
 *
 * The honesty paragraph below is a requirement, not decoration. The key is an
 * UNEXPIRING, UNSCOPED credential kept in this origin's `localStorage`, so:
 * a hostile cross-origin page cannot read it and cannot make the browser
 * attach it to anything (there is no CSRF shape here); but anyone using this
 * browser profile can read it out of devtools, and any script that manages to
 * run on this origin can exfiltrate it — an XSS here is a key disclosure, not
 * merely a hijacked session. "Sign out" is the only thing that removes it.
 */
export const KeyGate = (props: {
  apiKey: string | null;
  onKey: (key: string) => void;
  children: ReactNode;
}): JSX.Element => {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  if (props.apiKey !== null) return <>{props.children}</>;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setChecking(true);
    setProblem(null);
    try {
      // Verified BEFORE it is stored: a stored key that does not work turns
      // every screen into an error and the fix (clear localStorage) is not
      // one anybody guesses.
      await createApiClient({ apiKey: value }).get('/system/version');
      props.onKey(value);
    } catch {
      setProblem('That key was not accepted.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="key-gate">
      <h1>trawlarr</h1>
      <label htmlFor="api-key">API key</label>
      <input
        id="api-key"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <p>
        trawlarr generated an API key on its first start and printed it once. Find it with{' '}
        <code>docker logs trawlarr</code>, or run <code>docker exec trawlarr trawlarr status</code>{' '}
        — the CLI reads it from the same place.
      </p>
      {problem !== null && (
        <p role="alert" className="problem">
          {problem}
        </p>
      )}
      <button type="submit" disabled={checking || value === ''}>
        {checking ? 'Checking…' : 'Save'}
      </button>
      <details className="key-honesty">
        <summary>What this key protects, and what it does not</summary>
        <p>
          This is the same key a script uses, sent as <code>X-Api-Key</code> on every request. The
          UI has no privileged path: anything you can do here, you can do with <code>curl</code>.
        </p>
        <p>
          It is kept in this browser&rsquo;s local storage for this origin, not in a cookie. A
          hostile page on another site cannot read it and cannot make your browser send it — there
          is no session to ride on.
        </p>
        <p>
          It is <strong>not</strong> protected from anyone using this browser profile: it survives
          closing the tab, it is readable from the developer console, and any script that runs on
          this origin can take it. The key does not expire and is not scoped, so a disclosure is a
          disclosure of full API access until you rotate it. On a shared or unattended machine, use{' '}
          <strong>Sign out</strong>.
        </p>
      </details>
    </form>
  );
};
