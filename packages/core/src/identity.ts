import { sha256Hex } from './canonical-json.js';

export type IdentityKind = 'inode' | 'content';

export interface PartialHashParts {
  sizeBytes: number;
  /** Hex digest of the file's leading bytes. */
  headHex: string;
  /** Hex digest of the file's trailing bytes. */
  tailHex: string;
}

export interface IdentityCandidate {
  inodeKey: string | null;
  contentKey: string;
}

export interface IdentityLookup {
  byInodeKey(key: string): string | null;
  byContentKey(key: string): string | null;
}

export interface IdentityMatch {
  fileId: string | null;
  matchedBy: IdentityKind | null;
}

export const inodeKeyOf = (deviceId: number | bigint, inode: number | bigint): string =>
  `${deviceId.toString()}:${inode.toString()}`;

export const contentKeyOf = (parts: PartialHashParts): string =>
  sha256Hex(`${parts.sizeBytes}:${parts.headHex}:${parts.tailHex}`);

export const buildIdentityCandidate = (input: {
  deviceId: number | bigint | null;
  inode: number | bigint | null;
  hash: PartialHashParts;
}): IdentityCandidate => ({
  inodeKey:
    input.deviceId === null || input.inode === null
      ? null
      : inodeKeyOf(input.deviceId, input.inode),
  contentKey: contentKeyOf(input.hash),
});

/**
 * Resolve a scanned file to an existing record. Inode first because it is
 * cheap and stable across renames — the case that matters, since media
 * managers rename constantly. Content hash second, so a file that moved
 * across devices keeps its ledger instead of being reprocessed.
 */
export const matchIdentity = (
  candidate: IdentityCandidate,
  lookup: IdentityLookup,
): IdentityMatch => {
  if (candidate.inodeKey !== null) {
    const byInode = lookup.byInodeKey(candidate.inodeKey);
    if (byInode !== null) return { fileId: byInode, matchedBy: 'inode' };
  }

  const byContent = lookup.byContentKey(candidate.contentKey);
  if (byContent !== null) return { fileId: byContent, matchedBy: 'content' };

  return { fileId: null, matchedBy: null };
};
