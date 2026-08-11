import { describe, expect, it } from 'vitest';
import {
  buildIdentityCandidate,
  contentKeyOf,
  inodeKeyOf,
  matchIdentity,
  type IdentityLookup,
} from './identity.js';

const hash = { sizeBytes: 4096, headHex: 'aa11', tailHex: 'bb22' };

const lookup = (
  inodes: Record<string, string> = {},
  contents: Record<string, string> = {},
): IdentityLookup => ({
  byInodeKey: (k) => inodes[k] ?? null,
  byContentKey: (k) => contents[k] ?? null,
});

describe('identity keys', () => {
  it('builds a stable inode key from device and inode', () => {
    expect(inodeKeyOf(2049, 8675309)).toBe('2049:8675309');
  });

  it('accepts bigint stat values without precision loss', () => {
    expect(inodeKeyOf(2049n, 12345678901234567n)).toBe('2049:12345678901234567');
  });

  it('derives the content key from size, head and tail', () => {
    expect(contentKeyOf(hash)).toBe(contentKeyOf({ ...hash }));
    expect(contentKeyOf(hash)).not.toBe(contentKeyOf({ ...hash, sizeBytes: 4097 }));
  });

  it('omits the inode key when the filesystem reports none', () => {
    const candidate = buildIdentityCandidate({ deviceId: null, inode: null, hash });
    expect(candidate.inodeKey).toBeNull();
    expect(candidate.contentKey).toBe(contentKeyOf(hash));
  });
});

describe('matchIdentity', () => {
  it('prefers the inode match, which is the cheap common case', () => {
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    const result = matchIdentity(candidate, lookup({ '2049:42': 'file-1' }, {}));
    expect(result).toEqual({ fileId: 'file-1', matchedBy: 'inode' });
  });

  it('survives a rename: same inode, different path, still the same file', () => {
    // A Radarr quality upgrade renames the file; the inode is unchanged.
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    expect(matchIdentity(candidate, lookup({ '2049:42': 'file-1' })).fileId).toBe('file-1');
  });

  it('falls back to content when the inode has changed', () => {
    // A copy to a new device renumbers the inode but the bytes are identical.
    const candidate = buildIdentityCandidate({ deviceId: 3000, inode: 99, hash });
    const result = matchIdentity(candidate, lookup({}, { [contentKeyOf(hash)]: 'file-1' }));
    expect(result).toEqual({ fileId: 'file-1', matchedBy: 'content' });
  });

  it('treats a genuinely new file as new', () => {
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 7, hash });
    expect(matchIdentity(candidate, lookup())).toEqual({ fileId: null, matchedBy: null });
  });

  it('does not consult content when the inode already matched', () => {
    let contentCalls = 0;
    const spy: IdentityLookup = {
      byInodeKey: () => 'file-1',
      byContentKey: () => {
        contentCalls += 1;
        return 'file-2';
      },
    };
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    expect(matchIdentity(candidate, spy).fileId).toBe('file-1');
    expect(contentCalls).toBe(0);
  });
});
