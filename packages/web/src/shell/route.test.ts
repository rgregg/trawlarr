import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from './route.js';

describe('parseRoute', () => {
  it('reads the four modes', () => {
    expect(parseRoute('/', '')).toEqual({ name: 'watch' });
    expect(parseRoute('/diagnose', '')).toEqual({ name: 'diagnose' });
    expect(parseRoute('/config', '')).toEqual({ name: 'config', tab: 'workers' });
    expect(parseRoute('/files', '')).toEqual({
      name: 'files',
      filters: { library: null, state: null, q: null },
    });
  });

  it('carries file filters in the query string, not in component state', () => {
    expect(parseRoute('/files', '?library=lib-1&state=failed&q=foundation')).toEqual({
      name: 'files',
      filters: { library: 'lib-1', state: 'failed', q: 'foundation' },
    });
  });

  it('reads object routes', () => {
    expect(parseRoute('/files/abc-123', '')).toEqual({
      name: 'file',
      id: 'abc-123',
      filters: { library: null, state: null, q: null },
    });
    expect(parseRoute('/jobs/job-9', '')).toEqual({ name: 'job', id: 'job-9' });
    expect(parseRoute('/flows/flow-7', '')).toEqual({ name: 'flow', id: 'flow-7' });
  });

  it('carries the filters a file was opened from, so both ways back keep them', () => {
    // Arriving at a file from `/files?state=failed` must not drop the
    // filter — not on the back-link, and not for the list still mounted
    // behind the panel.
    expect(parseRoute('/files/abc-123', '?state=failed&library=lib-1')).toEqual({
      name: 'file',
      id: 'abc-123',
      filters: { library: 'lib-1', state: 'failed', q: null },
    });
  });

  it('names an unknown path rather than silently showing the default screen', () => {
    expect(parseRoute('/nope', '')).toEqual({ name: 'notFound', path: '/nope' });
  });

  it('round-trips every route through formatRoute', () => {
    const routes = [
      { name: 'watch' } as const,
      { name: 'diagnose' } as const,
      { name: 'file', id: 'abc-123', filters: { library: null, state: null, q: null } } as const,
      {
        name: 'file',
        id: 'abc-123',
        filters: { library: 'lib-1', state: 'failed', q: null },
      } as const,
      { name: 'job', id: 'job-9' } as const,
      { name: 'flow', id: 'flow-7' } as const,
      { name: 'config', tab: 'libraries' } as const,
      { name: 'files', filters: { library: 'lib-1', state: 'failed', q: 'x' } } as const,
    ];
    for (const route of routes) {
      const url = new URL(formatRoute(route), 'http://x');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });

  it('omits empty filters from the formatted URL', () => {
    expect(formatRoute({ name: 'files', filters: { library: null, state: null, q: null } })).toBe(
      '/files',
    );
  });
});
