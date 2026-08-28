import { useState } from 'react';
import type { ApiClient } from './api/client.js';
import { Activity } from './screens/Activity.js';
import { Files } from './screens/files/Files.js';
import { Libraries } from './screens/Libraries.js';
import { Overview } from './screens/Overview.js';
import { KeyGate } from './shell/KeyGate.js';
import { Link } from './shell/Link.js';
import { useApi } from './shell/useApi.js';
import { useLive } from './shell/useLive.js';
import { useRoute } from './shell/useRoute.js';
import type { Route } from './shell/route.js';
import './styles.css';

/**
 * The four modes, as nav entries. Each is a real path `useRoute` already
 * knows how to parse — the nav is not a second source of truth about what
 * screens exist, just labels over `route.ts`'s table.
 */
const NAV: Array<{ to: string; label: string; matches: Route['name'] }> = [
  { to: '/', label: 'Watch', matches: 'watch' },
  { to: '/diagnose', label: 'Diagnose', matches: 'diagnose' },
  { to: '/files', label: 'Files', matches: 'files' },
  { to: '/config', label: 'Configure', matches: 'config' },
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
  const { route, navigate } = useRoute();
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
        {NAV.map((entry) => (
          <Link
            key={entry.to}
            to={entry.to}
            navigate={navigate}
            className="nav-link"
            aria-current={route.name === entry.matches ? 'page' : undefined}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {/* Watch, Diagnose and Configure are still pre-redesign components at
          their old identities — Overview under Watch, Activity under
          Diagnose, Libraries under Configure — because those screens don't
          exist yet. Files is real now. Later tasks replace each remaining
          one in turn; nothing here reaches back into a Screen union, so a
          route can be repointed without touching the nav. */}
      <main>
        {route.name === 'watch' && (
          <Overview client={props.client} live={live} onOverall={setOverall} />
        )}
        {route.name === 'diagnose' && <Activity client={props.client} live={live} />}
        {route.name === 'files' && (
          <Files client={props.client} filters={route.filters} navigate={navigate} />
        )}
        {route.name === 'config' && <Libraries client={props.client} live={live} />}
        {route.name === 'notFound' && <p>No screen for {route.path}.</p>}
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
