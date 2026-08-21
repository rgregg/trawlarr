import { stat as statPath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import {
  computeSignature,
  extractFacts,
  isKnownGood,
  matchIdentity,
  newLedgerRecord,
  type LedgerRecord,
  type PartialHashParts,
} from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
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
  /**
   * Called after every database transaction this scan commits, with the
   * number of rows it wrote.
   *
   * Spec §3.3: `better-sqlite3` is synchronous, so a transaction's duration
   * is a span in which the API, the WebSocket and every heartbeat are
   * frozen. This seam is how that stays MEASURED rather than asserted — the
   * suite bounds the row counts, `pnpm bench:scan` times them. Nothing in
   * production sets it.
   */
  onTransactionCommitted?: (rows: number, elapsedMs: number) => void;
  /**
   * Seam for tests: how a walked file's partial hash is taken. Defaults to
   * the real `partialHashFile`; production code never sets it.
   *
   * It exists because the window this scanner's in-flight guard is about
   * lives INSIDE this call. The walk stats a file, this hash reads its
   * bytes, and only then does the scan consult the database — so a
   * replacement that lands, is probed, and is RECORDED while these bytes
   * are being read leaves the scan holding an identity that describes a
   * file which no longer exists at that path, and a database in which no
   * row is `running` any more. There is no other point in the loop where a
   * test can stand, because everything from the hash to the insert is one
   * synchronous block; and a test that merely runs a scan and a job
   * concurrently and hopes for that interleaving passes against broken code
   * almost every time (see the P2 prerequisites note on concurrency tests).
   */
  hashFile?: (path: string) => Promise<PartialHashParts>;
  /**
   * How many probes may be in flight at once. Defaults to
   * `DEFAULT_PROBE_CONCURRENCY`; the daemon and the CLI pass
   * `scan.probeConcurrency` (see `ScanSettings`).
   *
   * Clamped rather than validated here, because this is a performance dial
   * and not a correctness one: every value produces the same rows, only
   * sooner or later. `1` restores the strictly serial behaviour, and with
   * it the "at most one probe's work is at risk" rule exactly as it was.
   */
  probeConcurrency?: number;
  /**
   * Seam for tests: how a file is probed. Defaults to the real `probeFile`;
   * production code never sets it.
   *
   * It exists because the property this scanner's window is about — how many
   * probes run at once — is not observable from outside without standing
   * inside the probe. Spawning N real `ffprobe` processes and timing them
   * would measure the machine, and this project never asserts elapsed time.
   */
  probeFileImpl?: (input: { ffprobePath: string; path: string }) => Promise<ProbeData>;
}

/**
 * Probes in flight at once, when nothing says otherwise.
 *
 * FOUR, and deliberately not `cpus().length`. An `ffprobe` of one file is
 * spawn- and IO-latency-bound, not CPU-bound: it reads a container's header
 * off the mount and exits, so the thing a bigger number buys is more
 * outstanding requests to the filesystem, which is what a network mount
 * needs and what a local SSD does not care about. Meanwhile the scan runs
 * BESIDE the transcodes, which are what the cores are for — sizing the scan
 * to the CPU count would take the machine away from the work the user
 * actually asked for, on the one code path that walks their entire library.
 *
 * Four is a floor on the benefit (four-way on a latency-bound loop) and a
 * ceiling on the harm (four short-lived processes and four outstanding
 * reads). An operator whose mount wants more raises `scan.probeConcurrency`.
 */
export const DEFAULT_PROBE_CONCURRENCY = 4;

/** Widest window we will open, however the setting was written. */
const MAX_PROBE_CONCURRENCY = 64;

/** States a scan must never touch: terminal or already mid-flight. */
const NEVER_REQUEUE_STATES = new Set(['failed', 'not_converging', 'running']);

const stemOf = (path: string): string => basename(path).replace(/\.[^.]*$/, '');

/**
 * Is `b` still the file `a` described?
 *
 * Device and inode are the whole answer for a replacement: `Replace Original
 * File` links or renames a staged file into place and never writes through
 * the original, so a swap ALWAYS lands as a new inode. Size and mtime are
 * carried too, for the other thing that invalidates an observation — a file
 * still being written to.
 */
const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * How many times an observation that changed underneath the scan is retaken
 * before the scan settles for the last one it got.
 *
 * A replacement lands once, so the retake after it succeeds. A file being
 * actively written changes without limit, and that is what the bound is for:
 * the last observation is then used exactly as it was before this loop
 * existed, rather than the scan spinning on a download.
 */
const OBSERVE_ATTEMPTS = 3;

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
 *
 * That argument has a PRECONDITION, and stating it is the point of
 * `observeFile`: the identity being guarded has to be true of the file that
 * is at the path NOW. A scan observes a file with two reads — the walk's
 * `stat` and the partial hash of its bytes — and consults the database only
 * after both. If a run lands its replacement, probes it and RECORDS it
 * (`updateAfterRun` plus the ledger transition) while those bytes are being
 * read, then the identity the scan is holding is the original's, which no
 * row claims any more, and no row is `running` either — so this guard has
 * nothing to match and the scan inserts a ghost row from the far side of
 * the same window. Freshness of `listRunningPaths` cannot help: it is fresh
 * and correct, and the thing that is stale is the identity. `observeFile`
 * is what makes the observation current; this guard is only sound on top of
 * it.
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
  const hashFile = input.hashFile ?? partialHashFile;
  const runProbe = input.probeFileImpl ?? probeFile;
  const probeConcurrency = Math.min(
    MAX_PROBE_CONCURRENCY,
    Math.max(1, Math.floor(input.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY)),
  );

  /**
   * One walked file, observed: the stat and the partial hash that together
   * make up its identity, taken from the SAME file rather than from two
   * moments that a replacement landed between.
   *
   * The confirming stat is deliberately the last thing this does. Everything
   * from here to `upsertScanned` is one synchronous block — no `await`, and
   * `better-sqlite3` is synchronous — so in this process nothing can run
   * between confirming the observation and acting on it: not the report of a
   * forked worker arriving over IPC, not a timer, not another scan. The
   * identity the guard below is handed is therefore the file that is at that
   * path, which is the precondition the guard's whole argument rests on.
   *
   * Across processes (`trawlarr scan` beside a daemon, the normal
   * deployment) the residue is what a separate writer can commit inside that
   * synchronous block — microseconds of sqlite reads, rather than the whole
   * of a 128KB hash's IO, which is where the window used to be.
   */
  const observeFile = async (entry: {
    path: string;
    stat: Stats;
  }): Promise<{ stat: Stats; hash: PartialHashParts }> => {
    let stat = entry.stat;
    for (let attempt = 1; ; attempt += 1) {
      const hash = await hashFile(entry.path);
      if (attempt >= OBSERVE_ATTEMPTS) return { stat, hash };
      const after = await statPath(entry.path);
      if (sameFile(stat, after)) return { stat: after, hash };
      stat = after;
    }
  };

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
    await runChunked({
      db,
      items: pending.splice(0, pending.length),
      apply: persist,
      onTransactionCommitted: input.onTransactionCommitted,
    });
  };

  /**
   * Files that have been observed, upserted and found to need a probe, whose
   * probes have NOT been started yet. Never longer than `probeConcurrency`.
   */
  const probeWindow: { settled: Probed; path: string }[] = [];

  /**
   * Probe everything in the window at once, settle each result onto its own
   * file, and commit the lot in one transaction.
   *
   * A WINDOW, not a streaming pool, and the difference is the point. A pool
   * would keep probes in flight WHILE the walk observes the next file, which
   * is the one thing this loop cannot afford: `observeFile`'s confirming
   * `stat` is the last `await` before a wholly synchronous block (lookup,
   * in-flight guard, upsert), and that is what makes the identity handed to
   * the in-flight-output guard true of the file at that path NOW. A probe
   * resolving inside that block is impossible today because the block
   * contains no `await`; a probe resolving BETWEEN the confirming stat and
   * the block would be scheduled by the same microtask queue and reopen
   * exactly the gap the ghost-row fix closed. With a window there is never a
   * probe in flight while the walk is observing anything: either the walk
   * runs (no probes outstanding) or the window does (no walking). The
   * property is preserved by construction rather than by review.
   *
   * The cost of that choice is real and small: the walk's own IO does not
   * overlap the probes, so the scan takes `walk + probes/N` rather than
   * `max(walk, probes/N)`. The whole `probes` term is what a cold scan is
   * made of (see the P2c note), so the win is the same order either way, and
   * this version cannot reorder or interleave anything.
   *
   * ORDERING. Results are pushed in window order, and windows close in walk
   * order, so the database still sees files in the order the walk yielded
   * them. Nothing downstream depends on that — every row is upserted by
   * identity and every ledger transition is derived from that row alone —
   * but a scan whose writes follow its walk is a scan whose progress is
   * legible, and preserving it costs nothing here.
   *
   * A probe that fails is `unreadable` for its own file and nothing more:
   * one undecodable file must never discard the other N-1 probes in its
   * window, so the rejection is caught per file rather than by `Promise.all`.
   */
  const closeWindow = async (): Promise<void> => {
    if (probeWindow.length === 0) return;
    const batch = probeWindow.splice(0, probeWindow.length);
    await Promise.all(
      batch.map(async (item) => {
        summary.probed += 1;
        try {
          const probe = await runProbe({ ffprobePath, path: item.path });
          item.settled.probe = probe;
          item.settled.facts = extractFacts({
            probe,
            container: item.settled.container,
            sizeBytes: item.settled.sizeBytes,
          });
        } catch (err) {
          // A non-ProbeError is a bug or an exhausted machine, not a bad
          // file: it aborts the scan here exactly as it did when probing
          // was serial.
          if (!(err instanceof ProbeError)) throw err;
          summary.unreadable += 1;
        }
      }),
    );
    for (const item of batch) pending.push(item.settled);
    await flush();
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

    let observed;
    try {
      observed = await observeFile(entry);
    } catch {
      summary.unreadable += 1;
      continue;
    }
    const { stat, hash } = observed;

    const identity = identityFromStat({ stat, hash });
    const container = extname(entry.path).replace('.', '').toLowerCase();
    const nlink = stat.nlink;

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
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
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
      existingBeforeUpsert.size_bytes !== stat.size ||
      existingBeforeUpsert.mtime_ms !== stat.mtimeMs;

    const settled: Probed = {
      fileId,
      container,
      sizeBytes: stat.size,
      facts: null,
      probe: null,
    };

    // A file needing a probe joins the window and is written when the window
    // closes, so at most one WINDOW's probes are ever at risk — the same rule
    // as before, generalised from one to `probeConcurrency`, and identical to
    // it at `probeConcurrency: 1`. A file NOT needing a probe goes straight
    // to `pending` and accumulates to a full chunk without flushing: that
    // asymmetry is what keeps a 100,000-file rescan at ~200 transactions
    // rather than 100,000, and the window must not disturb it.
    if (doProbe) {
      probeWindow.push({ settled, path: entry.path });
      if (probeWindow.length >= probeConcurrency) await closeWindow();
      continue;
    }

    pending.push(settled);
    if (pending.length >= DEFAULT_CHUNK_SIZE) await flush();
  }

  // The last, partial window — and then everything the walk settled but did
  // not fill a chunk with. Both are inside the `for await`'s successful
  // completion, so an interrupted scan reaches neither: its open window is
  // the N-at-risk this design accepts, re-derived by the next scan from
  // `probe_json IS NULL`.
  await closeWindow();
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
