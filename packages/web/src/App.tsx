import { useState } from 'react';
import type { ApiClient } from './api/client.js';
import { Config } from './screens/config/Config.js';
import { Diagnose } from './screens/diagnose/Diagnose.js';
import { FileDetail } from './screens/files/FileDetail.js';
import { Files } from './screens/files/Files.js';
import { JobDetail } from './screens/jobs/JobDetail.js';
import { Watch } from './screens/watch/Watch.js';
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
// `file` is a separate route from `files` (see `route.ts`) and carries no
// filters of its own — reusing "no filter" here rather than inventing a
// second empty-filters literal keeps `filtersToQuery`'s "everything" case
// the one this shell ever asks for behind a detail panel.
const NO_FILE_FILTERS = { library: null, state: null, q: null };

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

      <main>
        {route.name === 'watch' && (
          <Watch client={props.client} live={live} navigate={navigate} onOverall={setOverall} />
        )}
        {route.name === 'diagnose' && <Diagnose client={props.client} navigate={navigate} />}
        {route.name === 'files' && (
          <Files client={props.client} filters={route.filters} navigate={navigate} />
        )}
        {route.name === 'file' && (
          // The list stays mounted behind the panel on desktop — a click
          // into a file should feel like opening a drawer over the table it
          // came from, not like leaving it. `file-detail-layout` in
          // styles.css is what hides the list below 48rem, where there is
          // no room for both and the panel becomes the whole screen.
          <div className="file-detail-layout">
            <Files client={props.client} filters={NO_FILE_FILTERS} navigate={navigate} />
            <FileDetail client={props.client} id={route.id} navigate={navigate} />
          </div>
        )}
        {route.name === 'job' && (
          <JobDetail client={props.client} id={route.id} live={live} navigate={navigate} />
        )}
        {route.name === 'config' && (
          <Config client={props.client} live={live} tab={route.tab} navigate={navigate} />
        )}
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
