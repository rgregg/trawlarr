/**
 * URLs are the app's state, not a `useState` in the shell.
 *
 * Everything an operator wants to send to themselves later — a failing file,
 * one job's reasons, a filtered list — has to survive a reload and paste into
 * a message. That is why filters live in the query string and why every
 * object has its own path: the previous shell held the current screen in
 * component state, so nothing in this UI was linkable at all.
 */
export interface FileFilters {
  library: string | null;
  state: string | null;
  q: string | null;
}

export type ConfigTab = 'workers' | 'libraries' | 'flows' | 'plugins' | 'system';

export type Route =
  | { name: 'watch' }
  | { name: 'diagnose' }
  | { name: 'files'; filters: FileFilters }
  // A file detail route CARRIES THE FILTERS IT WAS OPENED FROM. Opening a
  // file is not leaving the list: the list stays mounted behind the panel on
  // desktop, and the panel's back-link has to return to the view you came
  // from. Without them, arriving from `/files?state=failed` and going back
  // dropped the filter — and the list behind the panel was the whole
  // unfiltered library, which is also ~24 sequential requests nobody asked
  // for. Same three params as `files`, read and written identically.
  | { name: 'file'; id: string; filters: FileFilters }
  | { name: 'job'; id: string }
  | { name: 'flow'; id: string }
  | { name: 'flowEdit'; id: string }
  // A single entry from a flow's history, reached from the flow it belongs
  // to — `flowId` is known because the link that opens this route always
  // starts on that flow's page (see `FlowDetail.tsx`'s History section).
  | { name: 'flowVersion'; flowId: string; versionId: string }
  // The one place a version is reached WITHOUT its flow already in hand: a
  // job row carries `flowHash`, not a flow id (`JobDetail.tsx`, via
  // `describeFlowVersion` in `job-detail-model.ts`). `/flows/versions/:id`
  // rather than nesting under a flow, because there is no flow id here to
  // nest under — deliberately a second, parallel route to `flowVersion`
  // above rather than a variant of it, since the two are reached with
  // different information in hand and resolve it differently server-side
  // (`GET /flows/versions/:versionId` vs `GET /flows/:id/versions/:versionId`).
  | { name: 'flowVersionDirect'; versionId: string }
  // `from`/`to` are nullable so `/flows/:id/compare` alone is a valid,
  // linkable route (an empty comparison screen prompting for both sides)
  // rather than only ever existing pre-filled.
  | { name: 'flowCompare'; flowId: string; from: string | null; to: string | null }
  | { name: 'config'; tab: ConfigTab }
  | { name: 'notFound'; path: string };

const CONFIG_TABS: ConfigTab[] = ['workers', 'libraries', 'flows', 'plugins', 'system'];

const isConfigTab = (raw: string | null): raw is ConfigTab =>
  raw !== null && (CONFIG_TABS as string[]).includes(raw);

export const parseRoute = (pathname: string, search: string): Route => {
  const params = new URLSearchParams(search);
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const segments = path.split('/').filter((part) => part.length > 0);

  if (segments.length === 0) return { name: 'watch' };
  if (segments.length === 1 && segments[0] === 'diagnose') return { name: 'diagnose' };

  if (segments[0] === 'config' && segments.length === 1) {
    const tab = params.get('tab');
    return { name: 'config', tab: isConfigTab(tab) ? tab : 'workers' };
  }

  if (segments[0] === 'files') {
    const filters: FileFilters = {
      library: params.get('library'),
      state: params.get('state'),
      q: params.get('q'),
    };
    if (segments.length === 1) return { name: 'files', filters };
    if (segments.length === 2) return { name: 'file', id: segments[1]!, filters };
  }

  if (segments[0] === 'jobs' && segments.length === 2) return { name: 'job', id: segments[1]! };

  if (segments[0] === 'flows' && segments.length === 2) return { name: 'flow', id: segments[1]! };

  if (segments[0] === 'flows' && segments.length === 3 && segments[2] === 'edit') {
    return { name: 'flowEdit', id: segments[1]! };
  }

  if (segments[0] === 'flows' && segments.length === 4 && segments[2] === 'versions') {
    return { name: 'flowVersion', flowId: segments[1]!, versionId: segments[3]! };
  }

  // Three segments, second one literal `versions` — cannot be swallowed by
  // `flow` (two segments, a different length entirely) or by `flowVersion`
  // above (four segments, and its own literal falls at position 2, not 1).
  // The one real collision is a flow whose id happens to be literally
  // "versions" — the same class of edge case the server's own
  // `/flows/templates` route already accepts for a flow id of "templates"
  // (see `packages/server/src/api/routes/flows.ts`), not fixed there
  // either.
  if (segments[0] === 'flows' && segments.length === 3 && segments[1] === 'versions') {
    return { name: 'flowVersionDirect', versionId: segments[2]! };
  }

  if (segments[0] === 'flows' && segments.length === 3 && segments[2] === 'compare') {
    return {
      name: 'flowCompare',
      flowId: segments[1]!,
      from: params.get('from'),
      to: params.get('to'),
    };
  }

  return { name: 'notFound', path };
};

const filterQuery = (filters: FileFilters): string => {
  const params = new URLSearchParams();
  if (filters.library !== null) params.set('library', filters.library);
  if (filters.state !== null) params.set('state', filters.state);
  if (filters.q !== null) params.set('q', filters.q);
  const query = params.toString();
  return query.length === 0 ? '' : `?${query}`;
};

export const formatRoute = (route: Route): string => {
  switch (route.name) {
    case 'watch':
      return '/';
    case 'diagnose':
      return '/diagnose';
    case 'file':
      return `/files/${route.id}${filterQuery(route.filters)}`;
    case 'job':
      return `/jobs/${route.id}`;
    case 'flow':
      return `/flows/${route.id}`;
    case 'flowEdit':
      return `/flows/${route.id}/edit`;
    case 'flowVersion':
      return `/flows/${route.flowId}/versions/${route.versionId}`;
    case 'flowVersionDirect':
      return `/flows/versions/${route.versionId}`;
    case 'flowCompare': {
      const params = new URLSearchParams();
      if (route.from !== null) params.set('from', route.from);
      if (route.to !== null) params.set('to', route.to);
      const query = params.toString();
      return `/flows/${route.flowId}/compare${query.length === 0 ? '' : `?${query}`}`;
    }
    case 'config':
      return route.tab === 'workers' ? '/config' : `/config?tab=${route.tab}`;
    case 'notFound':
      return route.path;
    case 'files':
      return `/files${filterQuery(route.filters)}`;
  }
};
