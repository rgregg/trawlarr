import { lstat, opendir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FlowDefinition } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import type { LibraryRecord } from '../db/library-repo.js';
import { canonicalPath, pathContains } from '../fs/path-contains.js';
import { RESERVED_DIR_NAME } from './paths.js';

/**
 * The plugin id `Replace Original File` is registered under.
 *
 * Deliberately NOT resolved through `PluginRegistry`, unlike the four other
 * places that resolve a plugin id. This is a FIRST-PARTY id, and the
 * `trawlarr:` namespace is reserved twice over — `assertValidSourceSlug`
 * refuses it at install time and `parsePluginId` returns null for it at read
 * time — so no installed plugin can ever answer to this id, and asking the
 * registry could only ever return null. Nor can an installed plugin write
 * trawlarr's trash: only the host's own Replace Original File runner moves a
 * file there, so a flow full of community nodes and no Replace node holds no
 * originals to sweep and correctly gets the default retention.
 */
const REPLACE_ORIGINAL_PLUGIN_ID = 'trawlarr:replaceOriginal';

/**
 * The retention the node itself declares as its default, read out of its
 * own `details()` rather than written down a second time here. A second
 * copy would be a divergence waiting to happen: the tooltip a user reads
 * ("14 days") and the number the sweeper actually applies must be the same
 * value, not two values that agree today.
 */
export const DEFAULT_TRASH_RETENTION_DAYS: number = (() => {
  const declared = FIRST_PARTY_PLUGINS[REPLACE_ORIGINAL_PLUGIN_ID]?.module
    .details()
    .inputs.find((input) => input.name === 'trashRetentionDays')?.defaultValue;
  const parsed = Number(declared);
  // Not a fallback that can silently become 0: a retention of zero means
  // "purge the safety net immediately", which is the one value this must
  // never arrive at by accident.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
})();

const parseRetentionDays = (raw: unknown): number | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

/**
 * How long this flow says a replaced original must be kept.
 *
 * The LONGEST value any Replace Original File node declares wins. A flow can
 * hold several, and a sweep is irreversible: honouring the shortest would
 * delete originals a node in the same flow had promised to keep. A flow with
 * no such node — or one whose value is blank or unparseable — gets the
 * node's own declared default rather than zero, because a typo must never
 * be read as "purge everything now".
 */
export const trashRetentionDaysForFlow = (flow: FlowDefinition): number => {
  const declared = flow.nodes
    .filter((node) => node.pluginId === REPLACE_ORIGINAL_PLUGIN_ID)
    .map((node) => parseRetentionDays(node.inputs.trashRetentionDays))
    .filter((days): days is number => days !== null);
  if (declared.length === 0) return DEFAULT_TRASH_RETENTION_DAYS;
  return Math.max(...declared);
};

/**
 * Every directory this library's replaced originals can be sitting in: the
 * configured `trashDir` if there is one, otherwise the per-root default that
 * `resolveTrashDir` computes for a file under each root.
 *
 * Derived from the same `RESERVED_DIR_NAME` constant the resolver uses, for
 * the same reason `reservedDirsForLibrary` is: the sweeper and the writer
 * must not be able to disagree about where trash lives.
 */
export const trashDirsForLibrary = (library: LibraryRecord): string[] => {
  if (library.trashDir !== null) return [resolve(library.trashDir)];
  return [...new Set(library.roots.map((root) => join(resolve(root), RESERVED_DIR_NAME, 'trash')))];
};

/**
 * The name `moveToTrash` gives a replaced original:
 * `<stem>.<epochMs>[-<n>].<ext>`, where `<stem>` is the original's own name
 * (dots and all) and `<n>` disambiguates a collision.
 *
 * The timestamp in the NAME is the age this sweeper uses, and it is the only
 * trustworthy source. A move preserves mtime, so a film from 2009 trashed a
 * minute ago still stats as 2009 — ageing on mtime would delete the user's
 * only remaining copy on the very first sweep. `ctime` does move on rename,
 * but not on every filesystem trawlarr runs over, and being wrong here costs
 * the one safety net the destructive layer has.
 *
 * A consequence, and a deliberate one: an entry this pattern does not match
 * is something trawlarr did not put there, and is never removed.
 */
const TRASH_ENTRY_PATTERN = /\.(\d{10,})(?:-\d+)?(?:\.[^.]*)?$/;

const trashedAtMsOf = (name: string): number | null => {
  const match = TRASH_ENTRY_PATTERN.exec(name);
  if (match?.[1] === undefined) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export interface PurgeTrashInput {
  library: LibraryRecord;
  retentionDays: number;
  nowMs: number;
  /** Report what would go, remove nothing. */
  dryRun?: boolean;
}

export interface TrashSweepSummary {
  /** Trash directories actually examined. */
  dirsSwept: number;
  /** Trash directories that do not exist yet — nothing has been replaced there. */
  dirsMissing: number;
  /** Trash directories refused as unsafe to sweep (see `purgeTrash`). */
  dirsRefused: number;
  /** Entries removed (or, under `dryRun`, that would have been). */
  removed: number;
  bytesFreed: number;
  /** Entries kept because they are still inside the retention window. */
  retained: number;
  /** Entries left alone because they are not trawlarr trash entries. */
  skipped: number;
  /** Entries this sweep tried to remove and could not. */
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete replaced originals that have outlived the library's retention.
 *
 * This is the counterpart to the one step in trawlarr that destroys a user's
 * file, so the bias runs the other way throughout: EVERY recovery path in the
 * destructive layer — a swap that fails after the original was trashed, a
 * cross-device copy that dies partway, a human noticing a bad encode a week
 * later — depends on the trash still holding the original. A sweep that is
 * too eager destroys the only safety net the system has, and unlike a failed
 * transcode it cannot be retried.
 *
 * Four independent bounds, and an entry must clear all of them:
 *
 *  1. It is inside a resolved trash directory. Containment goes through
 *     `pathContains`, the canonicalising helper — the one this repo already
 *     destroyed a file by not using. Canonicalisation is what makes a
 *     symlink in the trash pointing at a live library file resolve OUTSIDE
 *     the trash and be left alone, rather than being followed out of the
 *     directory this function is allowed to touch.
 *  2. The directory itself does not contain (or equal) a library root. A
 *     misconfiguration that put trash above a root would otherwise turn this
 *     into a library-wide `rm`. `library-repo` already rejects that at
 *     creation time; this refuses it again at the moment of deletion,
 *     because that is where being wrong is unrecoverable.
 *  3. Its NAME carries a trawlarr trash timestamp (see
 *     `TRASH_ENTRY_PATTERN`), which is both how its age is computed and how
 *     "trawlarr put this here" is decided. Anything else — a file a human
 *     dropped in, a live `.trawlarr-reserve-*` lock another worker is
 *     holding, a directory — is not ours.
 *  4. It is a regular file, and it is strictly OLDER than the retention
 *     window. An entry exactly at the boundary is kept: a retention is a
 *     promise about how long something is available, so the inclusive side
 *     is the one that keeps the file.
 */
export const purgeTrash = async (input: PurgeTrashInput): Promise<TrashSweepSummary> => {
  const summary: TrashSweepSummary = {
    dirsSwept: 0,
    dirsMissing: 0,
    dirsRefused: 0,
    removed: 0,
    bytesFreed: 0,
    retained: 0,
    skipped: 0,
    failed: 0,
  };
  const retentionMs = Math.max(0, input.retentionDays) * DAY_MS;

  for (const trashDir of trashDirsForLibrary(input.library)) {
    // Canonical, so every containment decision below is made against the
    // same real directory the entries canonicalise into.
    const canonicalDir = canonicalPath(trashDir);

    if (input.library.roots.some((root) => pathContains(canonicalDir, root))) {
      summary.dirsRefused += 1;
      continue;
    }

    let dir;
    try {
      dir = await opendir(canonicalDir);
    } catch {
      // Not there (nothing has been replaced under this root yet), or not
      // readable. Either way there is nothing this sweep may safely do.
      summary.dirsMissing += 1;
      continue;
    }
    summary.dirsSwept += 1;

    try {
      for await (const entry of dir) {
        const entryPath = join(canonicalDir, entry.name);

        // Canonicalising containment, applied to the entry itself: a symlink
        // resolves to its target, so an entry pointing anywhere outside this
        // directory fails here and is never touched.
        if (!pathContains(canonicalDir, entryPath)) {
          summary.skipped += 1;
          continue;
        }

        const trashedAtMs = trashedAtMsOf(entry.name);
        // A dot-prefixed name is never a trash entry: `.trawlarr-reserve-*`
        // is a lock a worker may be holding RIGHT NOW (removing it admits
        // two workers to the critical section that destroys files), and
        // `.trawlarr-replace-*` is an in-flight cross-device copy.
        if (trashedAtMs === null || entry.name.startsWith('.')) {
          summary.skipped += 1;
          continue;
        }

        let stats;
        try {
          stats = await lstat(entryPath);
        } catch {
          summary.skipped += 1;
          continue;
        }
        // Trash entries are flat regular files by construction. A directory
        // is never descended into and a symlink is never followed.
        if (!stats.isFile()) {
          summary.skipped += 1;
          continue;
        }

        // A timestamp in the future is a clock that moved (or a filename
        // that only looks like ours). Nothing is deleted on the strength of
        // a negative age.
        const ageMs = input.nowMs - trashedAtMs;
        if (ageMs <= retentionMs) {
          summary.retained += 1;
          continue;
        }

        if (input.dryRun === true) {
          summary.removed += 1;
          summary.bytesFreed += stats.size;
          continue;
        }
        try {
          await unlink(entryPath);
          summary.removed += 1;
          summary.bytesFreed += stats.size;
        } catch {
          // One undeletable entry (a permission problem, a file being read)
          // must not stop the rest of the sweep.
          summary.failed += 1;
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
  }

  return summary;
};
