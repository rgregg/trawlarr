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

  it('routes a single flow version and a comparison', () => {
    expect(parseRoute('/flows/f1/versions/v9', '')).toEqual({
      name: 'flowVersion',
      flowId: 'f1',
      versionId: 'v9',
    });
    expect(parseRoute('/flows/f1/compare', '?from=v1&to=v2')).toEqual({
      name: 'flowCompare',
      flowId: 'f1',
      from: 'v1',
      to: 'v2',
    });
  });

  it('reaches a version by id alone — the route a job hash resolves to', () => {
    expect(parseRoute('/flows/versions/v9', '')).toEqual({
      name: 'flowVersionDirect',
      versionId: 'v9',
    });
  });

  it('is not swallowed by, and does not swallow, the two- and four-segment flow routes', () => {
    // Segment counts 2, 3 and 4 respectively — none of these three patterns
    // ever compete for the same path.
    expect(parseRoute('/flows/f1', '')).toEqual({ name: 'flow', id: 'f1' });
    expect(parseRoute('/flows/versions/v9', '')).toEqual({
      name: 'flowVersionDirect',
      versionId: 'v9',
    });
    expect(parseRoute('/flows/f1/versions/v9', '')).toEqual({
      name: 'flowVersion',
      flowId: 'f1',
      versionId: 'v9',
    });
  });

  it('round-trips the new flow routes', () => {
    for (const route of [
      { name: 'flowVersion', flowId: 'f1', versionId: 'v9' } as const,
      { name: 'flowVersionDirect', versionId: 'v9' } as const,
      { name: 'flowCompare', flowId: 'f1', from: 'v1', to: 'v2' } as const,
    ]) {
      const url = new URL(formatRoute(route), 'http://x');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
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
      { name: 'flowVersion', flowId: 'flow-7', versionId: 'v-1' } as const,
      { name: 'flowVersionDirect', versionId: 'v-1' } as const,
      { name: 'flowCompare', flowId: 'flow-7', from: null, to: null } as const,
      { name: 'flowCompare', flowId: 'flow-7', from: 'v-1', to: 'v-2' } as const,
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

describe('the account tab', () => {
  // A fifth Configure tab. Parsed like every other, and — the part worth a
  // test — an unknown `?tab=` still falls back to workers rather than
  // rendering nothing, which is the rule that keeps a stale bookmark or a
  // hand-typed URL from landing on a blank screen.
  it('parses ?tab=account and still falls back for an unknown tab', () => {
    expect(parseRoute('/config', 'tab=account')).toEqual({ name: 'config', tab: 'account' });
    expect(parseRoute('/config', 'tab=nonsense')).toEqual({ name: 'config', tab: 'workers' });
  });

  it('round-trips through formatRoute', () => {
    expect(formatRoute({ name: 'config', tab: 'account' })).toBe('/config?tab=account');
  });
});
