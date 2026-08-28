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

export type ConfigTab = 'workers' | 'libraries' | 'plugins' | 'system';

export type Route =
  | { name: 'watch' }
  | { name: 'diagnose' }
  | { name: 'files'; filters: FileFilters }
  | { name: 'file'; id: string }
  | { name: 'job'; id: string }
  | { name: 'flow'; id: string }
  | { name: 'config'; tab: ConfigTab }
  | { name: 'notFound'; path: string };

const CONFIG_TABS: ConfigTab[] = ['workers', 'libraries', 'plugins', 'system'];

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
    if (segments.length === 1) {
      return {
        name: 'files',
        filters: {
          library: params.get('library'),
          state: params.get('state'),
          q: params.get('q'),
        },
      };
    }
    if (segments.length === 2) return { name: 'file', id: segments[1]! };
  }

  if (segments[0] === 'jobs' && segments.length === 2) return { name: 'job', id: segments[1]! };
  if (segments[0] === 'flows' && segments.length === 2) return { name: 'flow', id: segments[1]! };

  return { name: 'notFound', path };
};

export const formatRoute = (route: Route): string => {
  switch (route.name) {
    case 'watch':
      return '/';
    case 'diagnose':
      return '/diagnose';
    case 'file':
      return `/files/${route.id}`;
    case 'job':
      return `/jobs/${route.id}`;
    case 'flow':
      return `/flows/${route.id}`;
    case 'config':
      return route.tab === 'workers' ? '/config' : `/config?tab=${route.tab}`;
    case 'notFound':
      return route.path;
    case 'files': {
      const params = new URLSearchParams();
      if (route.filters.library !== null) params.set('library', route.filters.library);
      if (route.filters.state !== null) params.set('state', route.filters.state);
      if (route.filters.q !== null) params.set('q', route.filters.q);
      const query = params.toString();
      return query.length === 0 ? '/files' : `/files?${query}`;
    }
  }
};
