import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { Db } from '../db/connection.js';
import type { LibraryRecord } from '../db/library-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { identityFromStat, partialHashFile } from '../fs/partial-hash.js';

export interface ForgetMissingInput {
  db: Db;
  library: LibraryRecord;
  /**
   * Forget exactly these rows, naming them the way `requeue --file` does.
   * An explicit id is also the way to forget a row in a terminal state (see
   * `keptTerminal`) — every row is still re-verified as missing first.
   */
  fileIds?: string[];
  /** Include `failed`/`not_converging` rows in a `--missing` sweep. */
  includeTerminal?: boolean;
  /** Report what would go, discard nothing. */
  dryRun?: boolean;
}

export interface ForgottenFile {
  fileId: string;
  path: string;
  state: string;
  /** Job rows that go with the row — the history this discards. */
  jobCount: number;
}

export interface ForgetSummary {
  /** Rows discarded (or, under `dryRun`, that would have been). */
  forgotten: number;
  /** Rows whose file turned out to be back: mark cleared instead of forgotten. */
  restored: number;
  /** Rows left because their absence could not be re-confirmed right now. */
  unconfirmed: number;
  /** Terminal rows deliberately kept for inspection (see below). */
  keptTerminal: number;
  /** Rows named explicitly that are not marked missing at all. */
  notMissing: number;
  files: ForgottenFile[];
}

/** Terminal by design: nothing retries these, and a human is expected to look. */
const TERMINAL_STATES = new Set(['failed', 'not_converging']);

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

type Verdict = 'gone' | 'back' | 'unconfirmed';

/**
 * Is this row's FILE still gone, right now?
 *
 * Re-verified at the moment of deletion rather than trusted from the
 * `missing_since_ms` flag an earlier scan wrote, because the whole premise
 * of the reconciliation guard is that "not seen" and "gone" are different
 * questions — and this is the one operation that cannot be undone.
 *
 * "Gone" is about the row's FILE, not about its path being free. A path can
 * be occupied again by a different file (a better rip lands at the same
 * name, which is ordinary for a media library and correctly opens a second
 * row), and that occupancy says nothing about the row whose content this
 * one is not. So an existing path is compared by IDENTITY — the same inode
 * and content keys the scanner matches on — and only a match means the
 * file itself is back.
 */
const verify = async (row: MediaFileRow): Promise<Verdict> => {
  let stat: Stats;
  try {
    stat = await lstat(row.path);
  } catch (error) {
    // ENOENT is the only answer that means "gone"; EACCES, EIO, ESTALE and
    // friends all mean "I could not check", which must never authorise a
    // deletion.
    return codeOf(error) === 'ENOENT' ? 'gone' : 'unconfirmed';
  }

  try {
    const identity = identityFromStat({ stat, hash: await partialHashFile(row.path) });
    // BYTES decide, never the inode. Inode numbers are recycled: a file
    // written at a freed path routinely inherits the deleted file's inode
    // (this repo already records that as an accepted risk), so an
    // inode-based comparison here would read "a better rip landed at the
    // same name" as "the original came back" and refuse to forget the dead
    // row for ever — the exact case this command exists for.
    return identity.contentKey === row.content_key ? 'back' : 'gone';
  } catch {
    return 'unconfirmed';
  }
};

/**
 * Discard rows whose file is gone for good, with the job history attached to
 * them.
 *
 * Marking (rather than deleting) is what `reconcileMissing` does and stays
 * the default: it keeps the history, and it is reversible. But a media
 * library churns — files are replaced by better rips constantly — so
 * without a way to forget, `media_file` still grows without bound, merely
 * with the dead rows labelled instead of miscounted. This is that way, and
 * it is deliberately a separate, explicit operation rather than something a
 * scan does on its own: reconciliation runs unattended, and nothing that
 * runs unattended should be able to destroy a record.
 *
 * TERMINAL ROWS ARE KEPT BY DEFAULT. A missing row in `failed` or
 * `not_converging` is the only remaining record of why trawlarr gave up on
 * that file — its attempt counts, and the step traces of every attempt —
 * and "the file failed repeatedly and then disappeared" is a sequence a user
 * will want to read, not one to sweep up automatically. They are reported as
 * `keptTerminal` and taken only when asked for: `includeTerminal`, or by
 * naming the row's id (which is a per-row instruction, not a sweep).
 *
 * Everything else is left alone for the same reason `reconcileMissing`
 * leaves things alone: a row whose file is back has its mark cleared
 * instead, and a row whose absence cannot be re-confirmed this instant is
 * not touched at all.
 */
export const forgetMissing = async (input: ForgetMissingInput): Promise<ForgetSummary> => {
  const mediaFileRepo = createMediaFileRepo(input.db);
  const jobRepo = createJobRepo(input.db);

  const summary: ForgetSummary = {
    forgotten: 0,
    restored: 0,
    unconfirmed: 0,
    keptTerminal: 0,
    notMissing: 0,
    files: [],
  };

  const named = input.fileIds !== undefined;
  const candidates: MediaFileRow[] = named
    ? input.fileIds!.flatMap((fileId) => {
        const row = mediaFileRepo.getById(fileId);
        return row === null ? [] : [row];
      })
    : mediaFileRepo.listMissing(input.library.id);

  for (const row of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    if (row.missing_since_ms === null) {
      // Only reachable when named explicitly: a row nothing has confirmed
      // missing is never forgotten on the strength of the caller's opinion.
      summary.notMissing += 1;
      continue;
    }
    if (!named && input.includeTerminal !== true && TERMINAL_STATES.has(row.state)) {
      summary.keptTerminal += 1;
      continue;
    }

    const verdict = await verify(row);
    if (verdict === 'unconfirmed') {
      summary.unconfirmed += 1;
      continue;
    }
    if (verdict === 'back') {
      if (input.dryRun !== true) mediaFileRepo.clearMissing(row.id);
      summary.restored += 1;
      continue;
    }

    const jobCount = jobRepo.listForFile(row.id).length;
    if (input.dryRun !== true) {
      // `job` (and `job_step` under it) cascade from `media_file`, so this
      // one statement is what discards the history — which is exactly why
      // callers are expected to say so before running it.
      input.db.prepare(`DELETE FROM media_file WHERE id = ?`).run(row.id);
    }
    summary.forgotten += 1;
    summary.files.push({ fileId: row.id, path: row.path, state: row.state, jobCount });
  }

  return summary;
};
