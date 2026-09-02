import type { ApiClient } from './api/client.js';
import { Config } from './screens/config/Config.js';
import { Diagnose } from './screens/diagnose/Diagnose.js';
import { FileDetail } from './screens/files/FileDetail.js';
import { Files } from './screens/files/Files.js';
import { FlowCompare } from './screens/flows/FlowCompare.js';
import { FlowDetail } from './screens/flows/FlowDetail.js';
import { FlowVersion } from './screens/flows/FlowVersion.js';
import { JobDetail } from './screens/jobs/JobDetail.js';
import { Watch } from './screens/watch/Watch.js';
import { AuthGate } from './shell/AuthGate.js';
import { Link } from './shell/Link.js';
import { useAuth } from './shell/useAuth.js';
import { FILES_NARROW, useMedia } from './shell/useMedia.js';
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
 * The shell, mounted once behind the auth gate.
 *
 * `useLive` takes no API key: a signed-in browser authenticates the socket
 * upgrade with the same session cookie it sends on every other request, and
 * the daemon accepts that alongside the API key on this one path — see
 * `ws.ts`'s `onUpgrade`.
 *
 * THE HEADER NO LONGER SHOWS AN OVERALL CONVERGENCE FIGURE. It used to come
 * from an `onOverall` callback `Watch` fired after its own libraries fetch,
 * which meant the number was wrong or blank on every other screen — Diagnose,
 * Files and Config never mounted `Watch` to produce it. Giving the shell its
 * own libraries fetch would fix that at the cost of a second `/libraries`
 * round trip racing Watch's, purely to keep a header line the operator can
 * already get on the Watch screen it summarises. Not worth the duplicate
 * fetch, so it is gone rather than made global.
 */
const Shell = (props: { client: ApiClient; signOut: () => void }): JSX.Element => {
  const { live, connected } = useLive(undefined);
  const { route, navigate } = useRoute();
  // Below 48rem the sheet sets `display: none` on the list behind the file
  // panel (`styles.css`), so mounting it there paged an entire library —
  // ~24 sequential requests on 4,625 files — to render nothing at all.
  const narrow = useMedia(FILES_NARROW);

  return (
    <div className="app">
      <header className="app-header">
        <span className="product">trawlarr</span>
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
        {route.name === 'watch' && <Watch client={props.client} live={live} navigate={navigate} />}
        {route.name === 'diagnose' && <Diagnose client={props.client} navigate={navigate} />}
        {route.name === 'files' && (
          <Files client={props.client} filters={route.filters} navigate={navigate} />
        )}
        {route.name === 'file' && (
          // The list stays mounted behind the panel on desktop — a click
          // into a file should feel like opening a drawer over the table it
          // came from, not like leaving it. It is THE SAME FILTERED LIST the
          // click came from: the route carries the filters (see `route.ts`),
          // so the table behind the panel is never the whole unfiltered
          // library, and `FileDetail`'s back-link returns to the exact view.
          <div className="file-detail-layout">
            {!narrow && <Files client={props.client} filters={route.filters} navigate={navigate} />}
            <FileDetail
              client={props.client}
              id={route.id}
              filters={route.filters}
              navigate={navigate}
            />
          </div>
        )}
        {route.name === 'job' && (
          <JobDetail client={props.client} id={route.id} live={live} navigate={navigate} />
        )}
        {route.name === 'flow' && (
          <FlowDetail client={props.client} id={route.id} navigate={navigate} />
        )}
        {route.name === 'flowVersion' && (
          <FlowVersion
            client={props.client}
            flowId={route.flowId}
            versionId={route.versionId}
            navigate={navigate}
          />
        )}
        {route.name === 'flowVersionDirect' && (
          // No flow id in hand — a job row's `flowHash` resolves only to a
          // version id (`describeFlowVersion` in `job-detail-model.ts`).
          // `FlowVersion` fetches `GET /flows/versions/:versionId` instead
          // of the flow-scoped route when `flowId` is `null`.
          <FlowVersion
            client={props.client}
            flowId={null}
            versionId={route.versionId}
            navigate={navigate}
          />
        )}
        {route.name === 'flowCompare' && (
          <FlowCompare
            client={props.client}
            flowId={route.flowId}
            from={route.from}
            to={route.to}
            navigate={navigate}
          />
        )}
        {route.name === 'config' && (
          <Config client={props.client} live={live} tab={route.tab} navigate={navigate} />
        )}
        {route.name === 'notFound' && (
          <div className="not-found">
            <p>No screen for {route.path}.</p>
            {/* An error state with no way out of it is a dead end; every
                other failure on this branch offers one. */}
            <Link to="/" navigate={navigate} className="not-found-home">
              Go to Watch
            </Link>
          </div>
        )}
      </main>
    </div>
  );
};

/**
 * ONE `useAuth` FOR THE WHOLE APP, deliberately: it owns the account, the
 * client built from its session, and the sign-out that clears both. A
 * second call would be a second copy of that state, and a 401 clearing one
 * of them would leave the other still rendering — which is exactly the
 * "stuck on an error screen you cannot escape" failure the 401 handling
 * exists to prevent.
 */
export const App = (): JSX.Element => {
  const auth = useAuth();

  return (
    <AuthGate auth={auth}>
      {auth.client !== null && (
        <Shell
          client={auth.client}
          signOut={() => {
            void auth.signOut();
          }}
        />
      )}
    </AuthGate>
  );
};
