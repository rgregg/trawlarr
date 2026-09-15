import { validatePathMap } from '@trawlarr/core';
import { describe, expect, it } from 'vitest';
import { initialLiveState, reduceLive } from '../../api/events.js';
import {
  joinCommand,
  nodeBuildLabel,
  nodeStatus,
  nodesRefreshKey,
  pathMapRows,
  unreachableSummary,
  validatePathMapRows,
  type NodeMutationResponse,
  type NodeResource,
} from './nodes-model.js';

const NODE: NodeResource = {
  id: 'node-1',
  name: 'basement-nuc',
  local: false,
  online: false,
  revokedAt: null,
  enrolled: false,
  enrollExpiresAt: null,
  lastSeenAt: null,
  buildVersion: null,
  hardwareTypes: [],
  hardwareCaps: {},
  pathMap: [],
  pathMapError: null,
  paused: false,
  schedule: { baseCounts: { transcode: 1, health: 1 } },
  libraries: [],
  running: [],
};

describe('nodeStatus', () => {
  it('is "Waiting to join" for a node that has never enrolled', () => {
    expect(nodeStatus(NODE)).toBe('Waiting to join');
  });

  it('is "Online" once enrolled and reachable', () => {
    expect(nodeStatus({ ...NODE, enrolled: true, online: true })).toBe('Online');
  });

  it('is "Offline" once enrolled but not currently reachable', () => {
    expect(nodeStatus({ ...NODE, enrolled: true, online: false })).toBe('Offline');
  });

  // Revoked wins over every other signal — a revoked node might still answer
  // pings (it just refuses to authenticate), and showing it as "Online"
  // would suggest it is still doing work.
  it('is "Revoked" even for a node that is enrolled and online', () => {
    expect(nodeStatus({ ...NODE, enrolled: true, online: true, revokedAt: 1_000 })).toBe('Revoked');
  });

  it('is "Revoked" even for a node that never enrolled', () => {
    expect(nodeStatus({ ...NODE, enrolled: false, revokedAt: 1_000 })).toBe('Revoked');
  });
});

describe('nodesRefreshKey', () => {
  const started = reduceLive(initialLiveState, {
    type: 'job.started',
    jobId: 'job-1',
    fileId: 'file-1',
    libraryId: 'lib-1',
    path: '/media/x.mkv',
    workerId: 'node-1:0',
    pid: null,
  });

  // The running count on each card comes from the job table, so a job
  // starting or finishing must re-fetch nodes even though neither emits
  // `nodes.changed`.
  it('changes when a job starts', () => {
    expect(nodesRefreshKey(started)).not.toBe(nodesRefreshKey(initialLiveState));
  });

  it('changes when a job finishes', () => {
    const finished = reduceLive(started, {
      type: 'job.finished',
      jobId: 'job-1',
      fileId: 'file-1',
      state: 'good',
      outcome: 'done',
    });
    expect(nodesRefreshKey(finished)).not.toBe(nodesRefreshKey(started));
  });

  it('changes on nodes.changed', () => {
    const changed = reduceLive(initialLiveState, {
      type: 'nodes.changed',
      nodeId: 'node-1',
      online: true,
    });
    expect(nodesRefreshKey(changed)).not.toBe(nodesRefreshKey(initialLiveState));
  });

  it('does not change on progress, so a transcode does not re-fetch every tick', () => {
    const progressed = reduceLive(started, {
      type: 'job.progress',
      jobId: 'job-1',
      percent: 40,
      stage: 'ffmpeg',
    });
    expect(nodesRefreshKey(progressed)).toBe(nodesRefreshKey(started));
  });
});

describe('nodeBuildLabel', () => {
  it('prints the build a node reported', () => {
    expect(nodeBuildLabel({ buildVersion: '0.4.1' })).toBe('Build 0.4.1.');
  });

  it('prints nothing for a node that has never connected', () => {
    expect(nodeBuildLabel({ buildVersion: null })).toBeNull();
  });
});

describe('validatePathMapRows', () => {
  it('accepts a set of valid, absolute, non-overlapping rows', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/media/movies', nodePath: '/mnt/nas/movies' },
        { serverPath: '/media/tv', nodePath: '/mnt/nas/tv' },
      ]),
    ).toBeNull();
  });

  it('flags a relative server path', () => {
    expect(validatePathMapRows([{ serverPath: 'media/movies', nodePath: '/mnt/nas' }])).toContain(
      'absolute',
    );
  });

  it('flags a relative node path', () => {
    expect(validatePathMapRows([{ serverPath: '/media/movies', nodePath: 'mnt/nas' }])).toContain(
      'absolute',
    );
  });

  it('flags a ".." segment in either column', () => {
    expect(validatePathMapRows([{ serverPath: '/media/../etc', nodePath: '/mnt/nas' }])).toContain(
      '..',
    );
    expect(validatePathMapRows([{ serverPath: '/media', nodePath: '/mnt/../etc' }])).toContain(
      '..',
    );
  });

  it('flags a server path listed more than once', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/media', nodePath: '/mnt/a' },
        { serverPath: '/media', nodePath: '/mnt/b' },
      ]),
    ).toBe('Server path "/media" is listed more than once.');
  });

  it('treats a trailing slash as the same path, as the server does', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/media', nodePath: '/mnt/a' },
        { serverPath: '/media/', nodePath: '/mnt/b' },
      ]),
    ).toBe('Server path "/media/" is listed more than once.');
  });

  it('flags a node path listed more than once', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/a', nodePath: '/x' },
        { serverPath: '/b', nodePath: '/x' },
      ]),
    ).toBe('This node\'s path "/x" is listed more than once.');
  });

  it('flags rows that nest on one side only', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/media/movies', nodePath: '/mnt' },
        { serverPath: '/media/tv', nodePath: '/mnt/tv' },
      ]),
    ).toContain('nest the same way');
  });

  it('flags a nested row that sits at a different suffix on each side', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/a', nodePath: '/x' },
        { serverPath: '/a/tv', nodePath: '/x/shows' },
      ]),
    ).toBe('"/a/tv" must sit at the same place under "/a" on both sides.');
  });

  it('accepts nested rows that nest identically on both sides', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/a', nodePath: '/x' },
        { serverPath: '/a/tv', nodePath: '/x/tv' },
      ]),
    ).toBeNull();
  });

  // The UI echo must refuse everything the server refuses: a rule it misses
  // round-trips to a 400 rendered far from the table in the server's wording.
  it('refuses exactly what core validatePathMap refuses, never in "mapped" wording', () => {
    const cases: { serverPath: string; nodePath: string }[][] = [
      [{ serverPath: 'lib', nodePath: '/x' }],
      [{ serverPath: '/a/./b', nodePath: '/x' }],
      [
        { serverPath: '/a', nodePath: '/x' },
        { serverPath: '/a/', nodePath: '/y' },
      ],
      [
        { serverPath: '/a', nodePath: '/x/' },
        { serverPath: '/b', nodePath: '/x' },
      ],
      [
        { serverPath: '/a', nodePath: '/x' },
        { serverPath: '/a/tv', nodePath: '/x/shows' },
      ],
      [
        { serverPath: '/media/movies', nodePath: '/mnt' },
        { serverPath: '/media/tv', nodePath: '/mnt/tv' },
      ],
      [
        { serverPath: '/', nodePath: '/x' },
        { serverPath: '/a', nodePath: '/y' },
      ],
      [
        { serverPath: '/a', nodePath: '/x' },
        { serverPath: '/a/tv', nodePath: '/x/tv' },
        { serverPath: '/b', nodePath: '/y' },
      ],
    ];
    for (const rows of cases) {
      let coreRefuses = false;
      try {
        validatePathMap(rows);
      } catch {
        coreRefuses = true;
      }
      const problem = validatePathMapRows(rows);
      expect(problem !== null, JSON.stringify(rows)).toBe(coreRefuses);
      expect(problem ?? '').not.toMatch(/mapped/i);
    }
  });
});

describe('joinCommand', () => {
  it('pins the docker command to the published sha tag, with a library volume placeholder', () => {
    expect(
      joinCommand({
        serverUrl: 'http://trawlarr.example.com:8787',
        token: 'tok_abc123',
        commit: '0341860aa1b2c3d4e5f60718293a4b5c6d7e8f90',
      }),
    ).toEqual({
      docker:
        'docker run -d --name trawlarr-node -e TRAWLARR_MODE=node ' +
        '-e TRAWLARR_SERVER=http://trawlarr.example.com:8787 ' +
        '-e TRAWLARR_NODE_TOKEN=tok_abc123 ' +
        '-v <library-path>:<path-this-node-uses> -v trawlarr-node:/config ' +
        'ghcr.io/rgregg/trawlarr:sha-0341860',
      cli: 'trawlarr node --server http://trawlarr.example.com:8787 --token tok_abc123',
    });
  });

  it('falls back to :main when the server reports no commit, never an unpublished version tag', () => {
    // `version` is 0.0.0 on every main build, and no :0.0.0 is ever pushed.
    expect(
      joinCommand({ serverUrl: 'http://s', token: 't', commit: null }).docker.endsWith(
        'ghcr.io/rgregg/trawlarr:main',
      ),
    ).toBe(true);
  });
});

describe('unreachableSummary', () => {
  it('names each unreachable library with its detail', () => {
    const node: NodeResource = {
      ...NODE,
      libraries: [
        { libraryId: 'lib-1', reachable: true, detail: 'ok' },
        { libraryId: 'lib-2', reachable: false, detail: 'not found' },
      ],
    };
    expect(unreachableSummary(node, { 'lib-1': 'Movies', 'lib-2': 'TV' })).toEqual([
      'TV: not found',
    ]);
  });

  it('falls back to the library id when its name is not known', () => {
    const node: NodeResource = {
      ...NODE,
      libraries: [{ libraryId: 'lib-9', reachable: false, detail: 'permission denied' }],
    };
    expect(unreachableSummary(node, {})).toEqual(['lib-9: permission denied']);
  });

  it('is empty when every library is reachable', () => {
    const node: NodeResource = {
      ...NODE,
      libraries: [{ libraryId: 'lib-1', reachable: true, detail: 'ok' }],
    };
    expect(unreachableSummary(node, {})).toEqual([]);
  });
});

describe('NodeMutationResponse', () => {
  /**
   * The compile-time half of the fix for the crash on Add node / Save
   * workers / Toggle paused / Save paths / Revoke: `POST /nodes`,
   * `PUT /nodes/:id` and `POST /nodes/:id/revoke` all answer with this
   * shape — `NodeResource` minus `local`/`online`/`running` — because only
   * `GET /nodes`'s LIST handler joins those three on. A mutation response
   * therefore has no `running` to call `.length` on, and this type is what
   * makes putting one where a list row belongs a build failure rather than
   * a runtime `TypeError` an operator hits by clicking "Save".
   */
  it('cannot stand in for a GET /nodes list row — it has no local/online/running', () => {
    const rows: NodeResource[] = [NODE];
    const mutationResponse: NodeMutationResponse = NODE;
    // @ts-expect-error a mutation response has no `local`/`online`/`running`
    // and must never be pushed into list-row state — see `Nodes.tsx`'s
    // `onMutated` callback, which reloads `GET /nodes` instead.
    rows.push(mutationResponse);
  });
});

describe('pathMapRows', () => {
  it('gives each row a stable, unique key', () => {
    const rows = pathMapRows([
      { serverPath: '/media/movies', nodePath: '/mnt/nas/movies' },
      { serverPath: '/media/tv', nodePath: '/mnt/nas/tv' },
    ]);
    expect(rows).toEqual([
      { serverPath: '/media/movies', nodePath: '/mnt/nas/movies', key: expect.any(String) },
      { serverPath: '/media/tv', nodePath: '/mnt/nas/tv', key: expect.any(String) },
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('is empty for an empty map', () => {
    expect(pathMapRows([])).toEqual([]);
  });
});
