import { describe, expect, it } from 'vitest';
import {
  joinCommand,
  nodeStatus,
  pathMapRows,
  unreachableSummary,
  validatePathMapRows,
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

  it('flags a server path mapped more than once', () => {
    expect(
      validatePathMapRows([
        { serverPath: '/media', nodePath: '/mnt/a' },
        { serverPath: '/media', nodePath: '/mnt/b' },
      ]),
    ).toContain('more than once');
  });
});

describe('joinCommand', () => {
  it('produces the docker and cli commands verbatim', () => {
    expect(
      joinCommand({
        serverUrl: 'http://trawlarr.example.com:8787',
        token: 'tok_abc123',
        version: '1.2.0',
      }),
    ).toEqual({
      docker:
        'docker run -d --name trawlarr-node -e TRAWLARR_MODE=node ' +
        '-e TRAWLARR_SERVER=http://trawlarr.example.com:8787 ' +
        '-e TRAWLARR_NODE_TOKEN=tok_abc123 -v trawlarr-node:/config ' +
        'ghcr.io/rgregg/trawlarr:1.2.0',
      cli: 'trawlarr node --server http://trawlarr.example.com:8787 --token tok_abc123',
    });
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
