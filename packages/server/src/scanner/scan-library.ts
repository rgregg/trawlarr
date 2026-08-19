import { basename, dirname, extname } from 'node:path';
import {
  computeSignature,
  extractFacts,
  isKnownGood,
  matchIdentity,
  newLedgerRecord,
  type LedgerRecord,
} from '@trawlarr/core';
import { walkFiles } from '../fs/walk.js';
import { reconcileMissing } from './reconcile.js';
import { reservedDirsForLibrary } from '../library/paths.js';
import { partialHashFile, identityFromStat } from '../fs/partial-hash.js';
import { probeFile, ProbeError } from '../probe/ffprobe.js';
import { DEFAULT_CHUNK_SIZE, runChunked } from '../db/chunked.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';
import {
  createMediaFileRepo,
  IdentityConflictError,
  type MediaFileRow,
} from '../db/media-file-repo.js';
import type { Db } from '../db/connection.js';

export interface ScanSummary {
  seen: number;
  added: number;
  updated: number;
  queued: number;
  skippedHardlinked: number;
  unreadable: number;
  alreadyGood: number;
  /**
   * Number of files `probeFile` was actually invoked for — the count that
   * proves the expensive step (rule 5) was skipped for unchanged files
   * rather than merely producing the same downstream numbers by chance.
   */
  probed: number;
  /**
   * Files left entirely alone because they are the in-flight output of a
   * run that has not finished recording itself yet (see `isInFlightOutput`).
   * Not an error and not a skip the user needs to act on: the run that owns
   * the file records it moments later, and the next scan sees it normally.
   */
  inFlight: number;
  /**
   * Rows this scan newly marked missing: their file is gone from disk. The
   * row itself is kept (see `reconcileMissing`), but it stops counting
   * towards the library's convergence and can no longer be claimed.
   */
  missing: number;
  /** Rows whose file came back, so their missing mark was cleared. */
  restored: number;
  /**
   * Library roots that could NOT be shown to be present, so nothing under
   * them was reconciled this scan. Non-zero is the signal that a mount is
   * down: the scan's other counters describe only the roots that were up.
   */
  rootsUnavailable: number;
}

export interface ScanLibraryInput {
  db: Db;
  libraryId: string;
  ffprobePath: string;
  nowMs: () => number;
  onProgress?: (seen: number) => void;
  /**
   * Reconcile under a root that exists but is completely empty. Off by
   * default: an empty directory is what an unmounted share looks like. See
   * `ReconcileInput.allowEmptyRoots`.
   */
  allowEmptyRoots?: boolean;
}

/** States a scan must never touch: terminal or already mid-flight. */
const NEVER_REQUEUE_STATES = new Set(['failed', 'not_converging', 'running']);

const stemOf = (path: string): string => basename(path).replace(/\.[^.]*$/, '');

/**
 * Is `candidate` a file some in-flight run is entitled to be producing right
 * now, for the library file `runningPath` names?
 *
 * `Replace Original File` takes the ORIGINAL's stem and only ever changes
 * the container (that rule is load-bearing elsewhere: the filename belongs
 * to the user, so a replacement can never adopt the staged file's name), so
 * a running row's file can legally appear at exactly one other path — same
 * directory, same stem, different extension — and nowhere else.
 *
 * This closes the window between the swap landing on disk and `runJob`
 * recording the new identity (`updateAfterRun`). Inside it the file's
 * identity matches NO row, so a scan walking the path would insert a second
 * row for a file that is already tracked; `updateAfterRun` then collides on
 * `UNIQUE (library_id, content_key)` and unwinds the run, leaving a ghost
 * row holding the pre-transcode probe that gets claimed and transcoded a
 * second time. `NEVER_REQUEUE_STATES` cannot help, because the walked file
 * is associated with no row at all.
 *
 * Chosen over the alternatives deliberately:
 *
 *  - "Make the identity update part of the same transaction as the swap"
 *    does not close anything: the scan's insert happens between the swap and
 *    ANY later observation, whatever transaction that observation sits in,
 *    because the swap itself is a filesystem operation no sqlite transaction
 *    contains.
 *  - "Reserve the identity before the swap" means writing a row's
 *    content_key from the staged file before it is in place, which is a
 *    guess: a cross-device replacement copies (new inode), a companion or
 *    hardlink guard can refuse after staging, and a run that dies mid-swap
 *    would leave the ledger describing a file that never landed — the
 *    ledger would stop being a record of what is on disk.
 *  - Skipping only paths EQUAL to a running row's path fails the moment the
 *    flow changes container (`movie.mkv` -> `movie.mp4`), which is the most
 *    common replacement of all.
 *
 * The ordering that makes this airtight: a run's row is `running`
 * (committed by `claimNext`) strictly before that run can put anything on
 * disk, so any file a scanner can SEE inside the window is covered by a
 * `running` row the scanner can already read — in this process or another
 * one against the same WAL database.
 */
const isInFlightOutput = (runningPath: string, candidate: string): boolean =>
  dirname(runningPath) === dirname(candidate) && stemOf(runningPath) === stemOf(candidate);

/**
 * Walk a library's roots, bring the database's view of each file up to date,
 * and decide whether each file needs (re-)work.
 *
 * This is the only place anything moves a file out of `good`: the queue
 * only ever claims `queued`/`held` rows, so re-deriving each file's
 * signature and comparing it against the stored one (rule 7 below) is the
 * entire mechanism by which editing a flow, or updating a plugin, causes a
 * previously-converged library to be re-evaluated. Skipping or weakening
 * that comparison would make trawlarr appear to work while silently never
 * reconverging anything after a change.
 */
export const scanLibrary = async (input: ScanLibraryInput): Promise<ScanSummary> => {
  const { db, libraryId, ffprobePath, nowMs, onProgress } = input;

  const library = createLibraryRepo(db).getById(libraryId);
  if (library === null) throw new Error(`Unknown library: ${libraryId}`);

  const flow = library.flowId === null ? null : createFlowRepo(db).getById(library.flowId);
  // A library with no flow attached cannot compute a signature: skip
  // queueing entirely rather than invent or default one.
  const flowDefinitionHash = flow?.definitionHash ?? null;

  const mediaFileRepo = createMediaFileRepo(db);

  const summary: ScanSummary = {
    seen: 0,
    added: 0,
    updated: 0,
    queued: 0,
    skippedHardlinked: 0,
    unreadable: 0,
    alreadyGood: 0,
    probed: 0,
    inFlight: 0,
    missing: 0,
    restored: 0,
    rootsUnavailable: 0,
  };

  /**
   * Every row this scan actually walked a file for. Reconciliation (the
   * final step) only considers rows NOT in here — a file the walk yielded
   * is present by definition, whatever its path column says afterwards.
   */
  const seenFileIds = new Set<string>();

  /**
   * One file, settled: probed if it needed probing, and carrying whatever
   * came back. `facts`/`probe` are null when the file was skipped (rule 5)
   * or its probe failed, both of which still need their ledger considered.
   */
  interface Probed {
    fileId: string;
    container: string;
    sizeBytes: number;
    facts: ReturnType<typeof extractFacts> | null;
    probe: Awaited<ReturnType<typeof probeFile>> | null;
  }

  /**
   * Write one settled file: its probe (if any) and the ledger transition
   * that probe implies. Always called inside `runChunked`'s transaction.
   */
  const persist = (item: Probed): void => {
    if (item.probe !== null && item.facts !== null) {
      mediaFileRepo.setProbe({ fileId: item.fileId, probe: item.probe, facts: item.facts });
    }

    const row = mediaFileRepo.getById(item.fileId);
    if (row === null) return;

    // Terminal states, and files already mid-flight, are left alone: a
    // scan must not silently retry a file the system has given up on.
    if (NEVER_REQUEUE_STATES.has(row.state)) return;

    if (flowDefinitionHash === null) return; // No flow: cannot compute a signature.

    // A signature needs facts as of THIS scan's container/size, not
    // whatever the row happens to hold now: extracted directly here
    // rather than through getProbe, which deliberately re-derives from
    // the row's current container/size and would silently drift from
    // "facts as of this scan" if the row were mutated again later.
    const facts =
      item.facts ??
      (row.probe_json === null
        ? null
        : extractFacts({
            probe: JSON.parse(row.probe_json) as Parameters<typeof extractFacts>[0]['probe'],
            container: item.container,
            sizeBytes: item.sizeBytes,
          }));
    if (facts === null) return; // Never probed (e.g. probe failure on a new file).

    const signature = computeSignature({ flowDefinitionHash, facts });

    const ledger: LedgerRecord = mediaFileRepo.getLedger(item.fileId) ?? newLedgerRecord();

    if (isKnownGood(ledger, signature)) {
      summary.alreadyGood += 1;
      return;
    }

    // Signature doesn't match (or file was never converged): (re-)queue it.
    // `signature` is deliberately NOT written here — it records the
    // signature the file last converged under, and only applyRunOutcome
    // (a successful run) is entitled to set it. Leaving it unchanged is
    // rule 7's "resetting nothing else". This is the step the whole
    // convergence design depends on.
    mediaFileRepo.setLedger({
      fileId: item.fileId,
      record: { ...ledger, state: 'queued' },
    });
    summary.queued += 1;
  };

  /** Settled files not yet written. Never allowed to grow past a chunk. */
  const pending: Probed[] = [];

  /**
   * Commit everything settled so far, in bounded transactions.
   *
   * Called DURING the walk, not once at the end, and that is the whole
   * point: probing is the expensive part of a scan (spec §4.1), and a
   * result that lives only in this process's memory is lost to a deploy, a
   * crash or an OOM kill. A scan interrupted at 60,000 of 100,000 files must
   * resume, not restart, and it resumes because the 60,000 probes are on
   * disk when the next scan applies its skip rule (`probe_json === null`, or
   * size/mtime changed) to them.
   *
   * `pending` is drained into `runChunked` rather than written per row so
   * that a settled library — where nothing is probed and the walk is pure
   * bookkeeping — still commits in chunk-sized transactions exactly as
   * before, instead of paying a transaction per file.
   */
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await runChunked({ db, items: pending.splice(0, pending.length), apply: persist });
  };

  // Walk, upsert identity, probe what needs it, and commit as we go. Probing
  // deliberately happens between transactions, never inside one: spawning
  // ffprobe while holding sqlite's write lock would block every other writer
  // for the length of an external process.
  for await (const entry of walkFiles({
    roots: library.roots,
    extensions: library.extensions,
    exclude: reservedDirsForLibrary(library),
  })) {
    summary.seen += 1;
    onProgress?.(summary.seen);

    let hash;
    try {
      hash = await partialHashFile(entry.path);
    } catch {
      summary.unreadable += 1;
      continue;
    }

    const identity = identityFromStat({ stat: entry.stat, hash });
    const container = extname(entry.path).replace('.', '').toLowerCase();
    const nlink = entry.stat.nlink;

    const lookup = mediaFileRepo.identityLookup(libraryId);
    const match = matchIdentity(identity, lookup);
    const isNew = match.fileId === null;

    // A file no row claims, at a path an in-flight run is entitled to be
    // producing, is not a new file — it is that run's replacement, caught
    // between landing on disk and being recorded. Leave it entirely alone
    // (no insert, no probe, no queue) and let the run that owns it record
    // it; the next scan sees it as the row it belongs to. Queried fresh
    // here rather than once per scan, so a job that started after this scan
    // began is still covered — see `listRunningPaths`. Committing this
    // scan's earlier files as it goes makes that freshness matter MORE, not
    // less: a row this very walk queued can be claimed and start producing
    // its replacement before the walk ends.
    if (isNew) {
      const running = mediaFileRepo.listRunningPaths(libraryId);
      if (running.some((runningPath) => isInFlightOutput(runningPath, entry.path))) {
        summary.inFlight += 1;
        continue;
      }
    }

    // Read the PRE-scan row now, before upsertScanned overwrites
    // size_bytes/mtime_ms with this scan's stat: comparing against the row
    // AFTER the upsert would compare the new stat to itself and never
    // detect a real change, silently defeating rule 5's probe-skip.
    const existingBeforeUpsert: MediaFileRow | null =
      match.fileId === null ? null : mediaFileRepo.getById(match.fileId);

    // upsertScanned preserves the existing record's identity across a
    // rename: path is deliberately not the identity key. One pathological
    // file must not abort the whole scan, so a conflict is counted and
    // skipped rather than thrown.
    let fileId: string;
    try {
      fileId = mediaFileRepo.upsertScanned({
        libraryId,
        identity,
        path: entry.path,
        nlink,
        sizeBytes: entry.stat.size,
        mtimeMs: entry.stat.mtimeMs,
        ctimeMs: entry.stat.ctimeMs,
        container,
        nowMs: nowMs(),
      });
    } catch (err) {
      if (err instanceof IdentityConflictError) {
        summary.unreadable += 1;
        continue;
      }
      throw err;
    }

    seenFileIds.add(fileId);

    if (isNew) summary.added += 1;
    else summary.updated += 1;

    // The file is back (restored from a backup, remounted, moved back).
    // Cleared here rather than inside `upsertScanned` so the scan can report
    // it: a row silently un-marking itself is indistinguishable from one
    // that was never marked, and "3 files came back" is the counterpart of
    // "3 files went missing" an operator needs to see.
    if (existingBeforeUpsert?.missing_since_ms != null) {
      mediaFileRepo.clearMissing(fileId);
      summary.restored += 1;
    }

    if (nlink > 1 && !library.allowHardlinked) {
      // Leave the file alone beyond tracking its identity: replacing a
      // hardlinked file either breaks the link or mutates a copy someone
      // else is still seeding. Never queue it.
      summary.skippedHardlinked += 1;
      continue;
    }

    const doProbe =
      isNew ||
      existingBeforeUpsert === null ||
      // A file whose probe has NEVER succeeded must be retried on every
      // scan: size/mtime alone would never re-probe it (nothing about a
      // file changes when ffprobe was merely busy, or the mount was
      // briefly unavailable, or the user has since replaced a truncated
      // download in place at the same size), so it sat in `unknown`
      // forever — permanently capping the library's convergence
      // percentage, with its only diagnostic long scrolled past.
      existingBeforeUpsert.probe_json === null ||
      existingBeforeUpsert.size_bytes !== entry.stat.size ||
      existingBeforeUpsert.mtime_ms !== entry.stat.mtimeMs;

    const settled: Probed = {
      fileId,
      container,
      sizeBytes: entry.stat.size,
      facts: null,
      probe: null,
    };

    if (doProbe) {
      summary.probed += 1;
      try {
        const probe = await probeFile({ ffprobePath, path: entry.path });
        settled.probe = probe;
        settled.facts = extractFacts({ probe, container, sizeBytes: entry.stat.size });
      } catch (err) {
        if (!(err instanceof ProbeError)) throw err;
        summary.unreadable += 1;
      }
    }

    pending.push(settled);

    // Commit as soon as anything expensive has been done, so at most one
    // probe is ever at risk; otherwise let cheap bookkeeping accumulate to
    // a full chunk. Either way `pending` never exceeds one transaction's
    // worth, which is why a 100k-file library still never opens a single
    // giant transaction.
    if (doProbe || pending.length >= DEFAULT_CHUNK_SIZE) await flush();
  }

  // Everything the walk settled but did not fill a chunk with.
  await flush();

  // Reconcile the rows the walk did NOT account for. Deliberately the last
  // thing, OUTSIDE the walk loop and reached only by the loop running to
  // completion: it compares against `seenFileIds`, which is only complete
  // once the whole walk has finished, and it must never run against a
  // partial walk — that is the shape that would purge a library whose scan
  // was interrupted. This is why probe results are committed incrementally
  // but reconciliation is NOT: an interrupted scan keeps its probes (the
  // expensive work, safe to keep because the next scan re-derives every
  // decision from the row) and reconciles nothing at all (a judgement that
  // is only sound with the complete picture a finished walk gives). A scan
  // killed mid-walk therefore leaves no row marked missing, however many
  // rows it never reached.
  const reconciled = await reconcileMissing({
    library,
    mediaFileRepo,
    seenFileIds,
    nowMs: nowMs(),
    allowEmptyRoots: input.allowEmptyRoots,
  });
  summary.missing = reconciled.missing;
  summary.rootsUnavailable = reconciled.rootsUnavailable;

  return summary;
};
