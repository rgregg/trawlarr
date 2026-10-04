import type { Db } from '../db/connection.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createRuntimeCheckRepo } from '../db/runtime-check-repo.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import {
  lookupExpectedRuntime,
  RuntimeSourceError,
  type ArrConfig,
  type RuntimeFetch,
} from '../library/runtime-sources.js';

/** Files asked about per pass, and the pause between asks. */
export const RUNTIME_CHECK_BATCH = 20;
export const RUNTIME_CHECK_DELAY_MS = 500;
/** This many sources failures in a row end the pass: the source is down, stop hammering it. */
const MAX_CONSECUTIVE_FAILURES = 3;
const REQUEST_TIMEOUT_MS = 15_000;

export interface RuntimeChecker {
  /**
   * One pass: look up expected runtimes for up to a batch of due files, one at
   * a time with a pause between. Returns how many were looked up. Never
   * throws for a source problem — a lookup failure is recorded as an attempt,
   * not as a mismatch — so the caller's timer cannot be killed by a dead
   * Radarr.
   */
  runOnce(): Promise<number>;
}

const defaultFetch: RuntimeFetch = (url, init) =>
  fetch(url, { headers: init.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/**
 * Lazy, background, rate-limited expected-runtime lookups.
 *
 * Runs on its own timer, never inside a scan: a scan of a large library must
 * not wait on (or be slowed by) a third-party service, and a source that is
 * down simply leaves files unchecked, which flags nothing.
 */
export const createRuntimeChecker = (input: {
  db: Db;
  settings: SettingsRepo;
  nowMs: () => number;
  fetchImpl?: RuntimeFetch;
  /** Seam: tests skip the real pause. */
  pause?: (ms: number) => Promise<void>;
  batch?: number;
  delayMs?: number;
  /** True once the daemon is stopping; ends a pass early instead of lingering through its pauses. */
  stopping?: () => boolean;
  onError?: (message: string) => void;
}): RuntimeChecker => {
  const repo = createRuntimeCheckRepo(input.db);
  const libraries = createLibraryRepo(input.db);
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const pause =
    input.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const batch = input.batch ?? RUNTIME_CHECK_BATCH;
  const delayMs = input.delayMs ?? RUNTIME_CHECK_DELAY_MS;

  return {
    async runOnce() {
      const tmdbApiKey = input.settings.getMetadata().tmdbApiKey;
      const all = libraries.list();
      const byId = new Map(all.map((library) => [library.id, library]));
      // A library has a source when it names an arr instance or a global TMDB
      // key exists. With neither there is nothing to ask, and nothing is read.
      const eligible = all.filter((l) => l.runtime.kind !== null || tmdbApiKey !== '');
      const due = repo.listDue({
        nowMs: input.nowMs(),
        libraryIds: eligible.map((library) => library.id),
        limit: batch,
      });

      let done = 0;
      let failures = 0;
      for (const file of due) {
        if (input.stopping?.() === true) break;
        if (done > 0) await pause(delayMs);
        const library = byId.get(file.libraryId);
        if (library === undefined) continue;
        const arr: ArrConfig | null =
          library.runtime.kind === null
            ? null
            : {
                kind: library.runtime.kind,
                url: library.runtime.url,
                apiKey: library.runtime.apiKey,
              };
        done += 1;
        try {
          const found = await lookupExpectedRuntime({
            path: file.path,
            arr,
            tmdbApiKey,
            fetchImpl,
          });
          repo.record({
            fileId: file.id,
            expectedMs: found?.expectedMs ?? null,
            source: found?.source ?? null,
            nowMs: input.nowMs(),
          });
          failures = 0;
        } catch (error) {
          // Counts as an attempt, so one unanswerable file cannot sit at the
          // head of the queue for ever, but it is NOT a "not found".
          repo.touch(file.id, input.nowMs());
          failures += 1;
          if (!(error instanceof RuntimeSourceError)) {
            input.onError?.(`runtime lookup for "${file.path}": ${(error as Error).message}`);
          } else if (failures === 1) {
            input.onError?.(`runtime source: ${error.message}`);
          }
          if (failures >= MAX_CONSECUTIVE_FAILURES) break;
        }
      }
      return done;
    },
  };
};
