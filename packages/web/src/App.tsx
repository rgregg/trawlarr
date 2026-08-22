import { useState } from 'react';
import type { ApiClient } from './api/client.js';
import { Activity } from './screens/Activity.js';
import { Libraries } from './screens/Libraries.js';
import { Overview } from './screens/Overview.js';
import { KeyGate } from './shell/KeyGate.js';
import { useApi } from './shell/useApi.js';
import { useLive } from './shell/useLive.js';
import './styles.css';

type Screen = 'overview' | 'libraries' | 'activity';

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'activity', label: 'Activity' },
];

/**
 * The shell, mounted once behind the key gate.
 *
 * `useLive` is called with the KEY rather than the client because the socket
 * is a separate credential path: a browser cannot set a header on a WebSocket
 * upgrade, so the key travels in the query string there and only there. Every
 * REST call still goes through `client`, which sends `X-Api-Key`.
 */
const Shell = (props: { apiKey: string; client: ApiClient; signOut: () => void }): JSX.Element => {
  const { live, connected } = useLive(props.apiKey);
  const [screen, setScreen] = useState<Screen>('overview');
  const [overall, setOverall] = useState<{ percent: number; total: number; good: number } | null>(
    null,
  );

  return (
    <div className="app">
      <header className="app-header">
        <span className="product">trawlarr</span>
        <span className="overall">
          {overall === null
            ? 'Convergence unknown'
            : `${String(overall.percent)}% converged (${String(overall.good)}/${String(overall.total)})`}
        </span>
        {/* Text, not a coloured dot: a disconnected socket is a liveness
            statement the operator has to be able to read, and the screens
            stay correct while it is down because they re-fetch. */}
        <span className={connected ? 'link link-up' : 'link link-down'}>
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
        <button type="button" onClick={props.signOut}>
          Sign out
        </button>
      </header>

      <nav className="app-nav" aria-label="Screens">
        {SCREENS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={screen === entry.id ? 'page' : undefined}
            onClick={() => {
              setScreen(entry.id);
            }}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main>
        {screen === 'overview' && (
          <Overview client={props.client} live={live} onOverall={setOverall} />
        )}
        {screen === 'libraries' && <Libraries client={props.client} live={live} />}
        {screen === 'activity' && <Activity client={props.client} live={live} />}
      </main>
    </div>
  );
};

/**
 * ONE `useApi` FOR THE WHOLE APP, deliberately: it owns the key, the client
 * built from it, and the sign-out that clears both. A second call would be a
 * second copy of that state, and a 401 clearing one of them would leave the
 * other still rendering — which is exactly the "stuck on an error screen you
 * cannot escape" failure the 401 handling exists to prevent.
 */
export const App = (): JSX.Element => {
  const { apiKey, client, urlKeyProblem, setKey, signOut } = useApi();

  return (
    <KeyGate apiKey={apiKey} onKey={setKey} initialProblem={urlKeyProblem}>
      {apiKey !== null && client !== null && (
        <Shell apiKey={apiKey} client={client} signOut={signOut} />
      )}
    </KeyGate>
  );
};
