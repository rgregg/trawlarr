import { extname } from 'node:path';
import {
  computeSignature,
  extractFacts,
  isKnownGood,
  matchIdentity,
  newLedgerRecord,
  type LedgerRecord,
} from '@trawlarr/core';
import { walkFiles } from '../fs/walk.js';
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
  for await (const entry of walkFiles({ roots: library.roots, extensions: library.extensions })) {
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

    const existing: MediaFileRow | null = isNew ? null : mediaFileRepo.getById(fileId);
    const doProbe =
      isNew ||
      existing === null ||
      existing.size_bytes !== entry.stat.size ||
      existing.mtime_ms !== entry.stat.mtimeMs;

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
