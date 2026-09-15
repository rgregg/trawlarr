import { describe, expect, it } from 'vitest';
import {
  joinCommand,
  nodeStatus,
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
