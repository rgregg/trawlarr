import type { FileState, WorkerClass } from '@trawlarr/core';
import type { ScanSummary } from '../scanner/scan-library.js';

/**
 * Everything the daemon tells the outside world about, as one union.
 *
 * These are NOTIFICATIONS, never the record: every one of them describes a
 * write that has already been made to the database (or a fact read out of
 * it), so a subscriber that misses one — an API client that connected a
 * moment too late, a log sink that threw — loses a message, never state.
 * That is the property that lets `emit` swallow a listener's exception
 * instead of unwinding into whatever job just finished.
 */
export type TrawlarrEvent =
  | {
      type: 'job.started';
      jobId: string;
      fileId: string;
      libraryId: string;
      path: string;
      workerId: string;
      /**
       * The forked worker's own pid, straight from the daemon's own fork —
       * never the agent's self-reported `ready.pid`, which arrives on a
       * channel a plugin can write to. Null only for a fake agent in a test
       * that never forked anything.
       *
       * Closes the gap a prior end-to-end suite named: sampling
       * `GET /workers` every 25ms cannot see a worker that starts and
       * finishes between two samples, but this event cannot be missed by a
       * subscriber that was listening before the job started.
       */
      pid: number | null;
    }
  | { type: 'job.progress'; jobId: string; percent: number | null; stage: string }
  | {
      type: 'job.step';
      jobId: string;
      seq: number;
      pluginId: string;
      outputNumber: number | null;
      durationMs: number;
    }
  | { type: 'job.log'; jobId: string; text: string }
  | { type: 'job.finished'; jobId: string; fileId: string; state: FileState; outcome: string }
  | { type: 'scan.progress'; libraryId: string; seen: number }
  | { type: 'scan.finished'; libraryId: string; summary: ScanSummary }
  /**
   * A plugin source sync, which the API accepts with a 202 and runs inside
   * the daemon. Three types rather than one with a flag: a UI shows a
   * spinner, a count and a refusal in three different places, and a failure
   * that arrives as a "finished" frame with a field set is the frame that
   * gets rendered as a success.
   */
  | { type: 'plugin.sync.started'; sourceId: string; runId: number }
  | {
      type: 'plugin.sync.finished';
      sourceId: string;
      runId: number;
      installed: number;
      skipped: number;
    }
  | { type: 'plugin.sync.failed'; sourceId: string; runId: number; code: string; message: string }
  | { type: 'library.paused'; libraryId: string; reason: string }
  | { type: 'library.resumed'; libraryId: string }
  | { type: 'workers.changed'; target: Record<WorkerClass, number>; active: number };

export interface EventBus {
  emit(event: TrawlarrEvent): void;
  /** Returns the unsubscribe function; calling it twice is a no-op. */
  subscribe(listener: (event: TrawlarrEvent) => void): () => void;
}

/**
 * A synchronous fan-out with two deliberate properties.
 *
 * A THROWING LISTENER IS ISOLATED. The publisher of nearly every event here
 * is a job completion path that has just written the file's ledger and is
 * about to refill the worker slot; letting an API client's serialisation bug
 * propagate out of `emit` would abort that path and strand the pool. So each
 * listener is called in its own `try`, and the remaining listeners still run.
 *
 * DELIVERY IS AGAINST A SNAPSHOT. Subscribing or unsubscribing from inside a
 * listener changes who receives the NEXT event, never the one in flight — a
 * subscriber added mid-emit would otherwise see an event it could not have
 * asked for, and one removed mid-emit could still be called after it said
 * stop, which is exactly when a closed socket gets written to.
 */
export const createEventBus = (): EventBus => {
  const listeners = new Set<(event: TrawlarrEvent) => void>();

  return {
    emit: (event) => {
      for (const listener of [...listeners]) {
        // The snapshot is what keeps a listener subscribed mid-emit out of
        // this event; this re-check is what keeps a listener UNsubscribed
        // mid-emit out of it too. Both directions matter, and a plain
        // snapshot only gives the first.
        if (!listeners.has(listener)) continue;
        try {
          listener(event);
        } catch {
          // A listener's failure is the listener's problem: it must never
          // reach the job that emitted the event. See the doc comment.
        }
      }
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
