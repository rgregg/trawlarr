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
import { reservedDirsForLibrary } from '../library/paths.js';
import { partialHashFile, identityFromStat } from '../fs/partial-hash.js';
import { probeFile, ProbeError } from '../probe/ffprobe.js';
import { runChunked } from '../db/chunked.js';
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
}

export interface ScanLibraryInput {
  db: Db;
  libraryId: string;
  ffprobePath: string;
  nowMs: () => number;
  onProgress?: (seen: number) => void;
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
  };

  interface Decision {
    fileId: string;
    isNew: boolean;
    doProbe: boolean;
    path: string;
    sizeBytes: number;
    mtimeMs: number;
    container: string;
  }

  const decisions: Decision[] = [];

  // Phase 1: walk + upsert identity. This determines, for every file seen,
  // whether it is new, changed, or unchanged, and whether it needs probing.
  // Kept out of runChunked's transactions because probing (phase 2) does
  // filesystem/process IO that must never happen inside a sqlite transaction.
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
    // began is still covered — see `listRunningPaths`.
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

    if (isNew) summary.added += 1;
    else summary.updated += 1;

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

    decisions.push({
      fileId,
      isNew,
      doProbe,
      path: entry.path,
      sizeBytes: entry.stat.size,
      mtimeMs: entry.stat.mtimeMs,
      container,
    });
  }

  // Phase 2: probe files that need it. Kept outside any sqlite transaction
  // since spawning ffprobe per file would otherwise hold a write lock open
  // for the duration of external process IO.
  interface Probed {
    fileId: string;
    container: string;
    sizeBytes: number;
    facts: ReturnType<typeof extractFacts> | null;
    probe: Awaited<ReturnType<typeof probeFile>> | null;
  }
  const probed: Probed[] = [];

  for (const decision of decisions) {
    if (!decision.doProbe) {
      probed.push({
        fileId: decision.fileId,
        container: decision.container,
        sizeBytes: decision.sizeBytes,
        facts: null,
        probe: null,
      });
      continue;
    }
    summary.probed += 1;
    try {
      const probe = await probeFile({ ffprobePath, path: decision.path });
      const facts = extractFacts({
        probe,
        container: decision.container,
        sizeBytes: decision.sizeBytes,
      });
      probed.push({
        fileId: decision.fileId,
        container: decision.container,
        sizeBytes: decision.sizeBytes,
        facts,
        probe,
      });
    } catch (err) {
      if (err instanceof ProbeError) {
        summary.unreadable += 1;
        probed.push({
          fileId: decision.fileId,
          container: decision.container,
          sizeBytes: decision.sizeBytes,
          facts: null,
          probe: null,
        });
        continue;
      }
      throw err;
    }
  }

  // Phase 3: persist probe results and ledger transitions in bounded chunks.
  await runChunked({
    db,
    items: probed,
    apply: (item) => {
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
    },
  });

  return summary;
};
