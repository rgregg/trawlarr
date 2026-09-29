import { describe, expect, it } from 'vitest';
import { createPlexNotifier, plexRefreshPath, type PlexConfig } from './plex-notify.js';

const config = (overrides?: Partial<PlexConfig>): PlexConfig => ({
  url: 'http://plex.lan:32400',
  token: 'tok-123',
  sectionId: '2',
  pathPrefix: '/data/usenet/shows',
  ...overrides,
});

/**
 * A fetch double that records what was asked for and answers on command.
 * Deliberately not a spy on the global: the notifier must never reach the
 * network on its own, and injecting the only way it can is what proves it.
 */
const recorder = (): {
  calls: { url: string; headers: Record<string, string> }[];
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
  }>;
  reply: { ok: boolean; status: number } | Error;
} => {
  const state = {
    calls: [] as { url: string; headers: Record<string, string> }[],
    reply: { ok: true, status: 200 } as { ok: boolean; status: number } | Error,
    fetchImpl: async (url: string, init: { method: string; headers: Record<string, string> }) => {
      state.calls.push({ url, headers: init.headers });
      if (state.reply instanceof Error) throw state.reply;
      return state.reply;
    },
  };
  return state;
};

describe('plexRefreshPath', () => {
  it('rewrites the library root to the prefix Plex itself uses', () => {
    // The whole point of the mapping: trawlarr sees /library/shows, Plex sees
    // /data/usenet/shows, and a refresh sent with trawlarr's spelling is
    // silently ignored by Plex rather than rejected.
    expect(
      plexRefreshPath({
        roots: ['/library/shows'],
        pathPrefix: '/data/usenet/shows',
        filePath: '/library/shows/Pokémon/Season 20/ep.mkv',
      }),
    ).toBe('/data/usenet/shows/Pokémon/Season 20');
  });

  it('scopes to the containing directory, not the file', () => {
    expect(
      plexRefreshPath({
        roots: ['/library/movies'],
        pathPrefix: '/data/usenet/movies',
        filePath: '/library/movies/Dune (2021)/Dune.mkv',
      }),
    ).toBe('/data/usenet/movies/Dune (2021)');
  });

  it('refuses to scope a multi-root library, because one prefix cannot describe two roots', () => {
    // A real Plex section holds several locations (/data/movies AND
    // /data/usenet/movies on the deployment this was written against).
    // Rewriting whichever root matched onto a single prefix would name a
    // directory under the wrong location, and Plex answers 200 to that and
    // scans nothing. The whole section is coarser and correct.
    expect(
      plexRefreshPath({
        roots: ['/library/movies', '/library/shows'],
        pathPrefix: '/data/usenet/shows',
        filePath: '/library/shows/Andor/Season 1/ep.mkv',
      }),
    ).toBeNull();
  });

  it('does not treat a sibling directory as a root match', () => {
    // "/library/show" must not match "/library/shows-archive/..." — a prefix
    // compare without the separator would map the file into the wrong section
    // and refresh a directory that does not exist.
    expect(
      plexRefreshPath({
        roots: ['/library/show'],
        pathPrefix: '/data/usenet/show',
        filePath: '/library/shows-archive/X/ep.mkv',
      }),
    ).toBeNull();
  });

  it('returns null when no prefix is configured, so the caller refreshes the whole section', () => {
    expect(
      plexRefreshPath({
        roots: ['/library/shows'],
        pathPrefix: null,
        filePath: '/library/shows/X/ep.mkv',
      }),
    ).toBeNull();
  });
});

describe('createPlexNotifier', () => {
  const harness = (
    overrides?: Partial<Parameters<typeof createPlexNotifier>[0]>,
  ): {
    notifier: ReturnType<typeof createPlexNotifier>;
    rec: ReturnType<typeof recorder>;
    fire: () => Promise<void>;
    errors: string[];
    pending: () => number;
  } => {
    const rec = recorder();
    const errors: string[] = [];
    let timer: (() => void) | null = null;
    const notifier = createPlexNotifier({
      fetchImpl: rec.fetchImpl,
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => {
        timer = null;
      },
      onError: (message) => errors.push(message),
      windowMs: 10_000,
      ...overrides,
    });
    return {
      notifier,
      rec,
      errors,
      pending: () => (timer === null ? 0 : 1),
      fire: async () => {
        const run = timer;
        timer = null;
        run?.();
        // Let the notifier's own awaits settle before assertions.
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
  };

  it('sends one path-scoped refresh with the token in a header', async () => {
    const h = harness();
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config(),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    await h.fire();

    expect(h.rec.calls).toHaveLength(1);
    expect(h.rec.calls[0]!.url).toBe(
      'http://plex.lan:32400/library/sections/2/refresh?path=%2Fdata%2Fusenet%2Fshows%2FAndor%2FSeason%201',
    );
    // In a header, never the query string: the query string is what lands in
    // an access log and in the job log's own request line.
    expect(h.rec.calls[0]!.headers['X-Plex-Token']).toBe('tok-123');
    expect(h.rec.calls[0]!.url).not.toContain('tok-123');
  });

  it('does not touch the network until the window closes', () => {
    const h = harness();
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config(),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    expect(h.rec.calls).toHaveLength(0);
    expect(h.pending()).toBe(1);
  });

  it('collapses a burst in one directory into a single refresh', async () => {
    // The reason this exists: a season pack converging sends one replacement
    // per episode, and Plex re-reads the whole directory anyway.
    const h = harness();
    for (const episode of ['ep1.mkv', 'ep2.mkv', 'ep3.mkv']) {
      h.notifier.fileReplaced({
        libraryId: 'lib-1',
        config: config(),
        roots: ['/library/shows'],
        path: `/library/shows/Andor/Season 1/${episode}`,
      });
    }
    await h.fire();
    expect(h.rec.calls).toHaveLength(1);
  });

  it('sends one refresh per distinct directory', async () => {
    const h = harness();
    for (const season of ['Season 1', 'Season 2']) {
      h.notifier.fileReplaced({
        libraryId: 'lib-1',
        config: config(),
        roots: ['/library/shows'],
        path: `/library/shows/Andor/${season}/ep.mkv`,
      });
    }
    await h.fire();
    expect(h.rec.calls).toHaveLength(2);
  });

  it('falls back to one section-wide refresh when a burst is too wide', async () => {
    // A library-wide reconverge would otherwise send thousands of requests —
    // the exact caution the migration guide gives about per-file notify nodes.
    const h = harness({ maxPaths: 3 });
    for (let index = 0; index < 10; index += 1) {
      h.notifier.fileReplaced({
        libraryId: 'lib-1',
        config: config(),
        roots: ['/library/shows'],
        path: `/library/shows/Show ${index}/Season 1/ep.mkv`,
      });
    }
    await h.fire();
    expect(h.rec.calls).toHaveLength(1);
    expect(h.rec.calls[0]!.url).toBe('http://plex.lan:32400/library/sections/2/refresh');
  });

  it('refreshes the whole section when the path cannot be mapped', async () => {
    const h = harness();
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config({ pathPrefix: null }),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    await h.fire();
    expect(h.rec.calls).toHaveLength(1);
    expect(h.rec.calls[0]!.url).toBe('http://plex.lan:32400/library/sections/2/refresh');
  });

  it('keeps libraries apart', async () => {
    const h = harness();
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config({ sectionId: '2' }),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    h.notifier.fileReplaced({
      libraryId: 'lib-2',
      config: config({ sectionId: '1', pathPrefix: '/data/usenet/movies' }),
      roots: ['/library/movies'],
      path: '/library/movies/Dune (2021)/Dune.mkv',
    });
    await h.fire();
    const sections = h.rec.calls.map((call) => call.url.split('/sections/')[1]!.split('/')[0]);
    expect(new Set(sections)).toEqual(new Set(['1', '2']));
  });

  it('ignores a library with no Plex URL configured', async () => {
    const h = harness();
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config({ url: '' }),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    expect(h.pending()).toBe(0);
    await h.fire();
    expect(h.rec.calls).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it('reports a refused refresh without throwing', async () => {
    const h = harness();
    h.rec.reply = { ok: false, status: 401 };
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config(),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    await h.fire();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('401');
    // The token must not travel into a log line.
    expect(h.errors[0]).not.toContain('tok-123');
  });

  it('reports an unreachable Plex without throwing', async () => {
    // A media server being down must never invalidate a transcode that has
    // already been installed: the file is converged whether or not Plex heard.
    const h = harness();
    h.rec.reply = new Error('ECONNREFUSED');
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config(),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    await expect(h.fire()).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('ECONNREFUSED');
  });

  it('drops a pending window on stop rather than firing after shutdown', async () => {
    const h = harness();
    h.notifier.fileReplaced({
      libraryId: 'lib-1',
      config: config(),
      roots: ['/library/shows'],
      path: '/library/shows/Andor/Season 1/ep.mkv',
    });
    h.notifier.stop();
    expect(h.pending()).toBe(0);
    await h.fire();
    expect(h.rec.calls).toHaveLength(0);
  });
});
