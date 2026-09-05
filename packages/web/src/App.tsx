import type { ApiClient } from './api/client.js';
import type { AccountResource } from './api/session.js';
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
import { attentionBadge, attentionLabel } from './shell/attention.js';
import { BrandMark } from './shell/BrandMark.js';
import { Link } from './shell/Link.js';
import { PageHeader } from './shell/PageHeader.js';
import { ThemeToggle } from './shell/ThemeToggle.js';
import { useAttention } from './shell/useAttention.js';
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
 *
 * `subtitle` is the screen's one-line answer to "what am I looking at",
 * rendered by the shell's `PageHeader`. It says what the screen shows, in
 * the operator's words rather than the daemon's — and it must stay true of
 * an install with nothing configured, which is exactly when someone is
 * reading it.
 */
const NAV: Array<{ to: string; label: string; matches: Route['name']; subtitle: string }> = [
  {
    // "Status", but `Route['name']` is still `watch` — renaming the route
    // name, `Watch.tsx`, `watch-model.ts` and the `.watch-*` class names
    // would be a large diff for a label change, so the divergence is here,
    // in one place, said out loud.
    to: '/',
    label: 'Status',
    matches: 'watch',
    subtitle: 'What the workers are doing, and how close each library is to converged.',
  },
  {
    to: '/diagnose',
    label: 'Diagnose',
    matches: 'diagnose',
    subtitle: 'Files that are failed, held or stuck, grouped by what went wrong.',
  },
  {
    to: '/files',
    label: 'Files',
    matches: 'files',
    subtitle: 'Every known file, its codecs, and the state the ledger has it in.',
  },
  {
    to: '/config',
    label: 'Configure',
    matches: 'config',
    subtitle: 'Libraries, workers, plugin sources and the schedule.',
  },
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
const Shell = (props: {
  client: ApiClient;
  account: AccountResource;
  signOut: () => void;
}): JSX.Element => {
  const { live, connected } = useLive(undefined);
  const { route, navigate } = useRoute();
  // Below 48rem the sheet sets `display: none` on the list behind the file
  // panel (`styles.css`), so mounting it there paged an entire library —
  // ~24 sequential requests on 4,625 files — to render nothing at all.
  const narrow = useMedia(FILES_NARROW);
  // Re-counted when a job ends (the only way a file enters `failed` or
  // `held`) or a library changes (a scan can bring new files in).
  const attention = useAttention(props.client, live.staleness.jobs + live.staleness.libraries);
  // The four top-level screens get their title from the same table the nav
  // is built from, so a screen cannot end up with a tab called one thing
  // and a heading called another. Detail screens are absent from it and
  // render their own header, because only they know the thing's name.
  const page = NAV.find((entry) => entry.matches === route.name);

  return (
    <div className="app">
      {/* Identity and connection above, navigation below. Splitting the two
          rows by role rather than by fit is what lets the same structure
          hold from 320px up, with no width at which it re-arranges into
          something the operator has to re-learn. */}
      <div className="app-masthead">
        <header className="app-header">
          <span className="app-brand">
            <BrandMark />
            <span className="product">trawlarr</span>
          </span>
          {/* One group, so that at 390px the three of them wrap onto a
              second line TOGETHER rather than leaving Sign out stranded on
              a row of its own, which reads as a layout accident. */}
          <div className="app-header-actions">
            {/* Text, not a coloured dot alone: a disconnected socket is a
                liveness statement the operator has to be able to read, and
                the screens stay correct while it is down because they
                re-fetch. */}
            <span className={connected ? 'link link-up' : 'link link-down'}>
              {connected ? 'Live' : 'Reconnecting…'}
            </span>
            <ThemeToggle />
            <button type="button" onClick={props.signOut}>
              Sign out
            </button>
          </div>
        </header>

        <nav className="app-nav" aria-label="Screens">
          {NAV.map((entry) => {
            // Only Diagnose carries a count, and only when it is not zero:
            // a badge reading "0" is a permanent mark on a tab that has
            // nothing to say, which is how a badge stops being read at all.
            const badge =
              entry.matches === 'diagnose' && attention !== null && attention > 0
                ? attention
                : null;
            return (
              <Link
                key={entry.to}
                to={entry.to}
                navigate={navigate}
                className="nav-link"
                aria-current={route.name === entry.matches ? 'page' : undefined}
                aria-label={badge === null ? undefined : attentionLabel(badge)}
              >
                {entry.label}
                {badge !== null && (
                  // `aria-hidden`, because `aria-label` above already says
                  // what this number means in a sentence. Left visible it
                  // would be announced twice, the second time as a bare
                  // digit with no noun attached.
                  <span className="nav-badge" aria-hidden="true">
                    {attentionBadge(badge)}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <main>
        {page !== undefined && <PageHeader title={page.label} subtitle={page.subtitle} />}

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
          <Config
            client={props.client}
            live={live}
            tab={route.tab}
            account={props.account}
            navigate={navigate}
          />
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
      {auth.client !== null && auth.account !== null && auth.account !== undefined && (
        <Shell
          client={auth.client}
          account={auth.account}
          signOut={() => {
            void auth.signOut();
          }}
        />
      )}
    </AuthGate>
  );
};
