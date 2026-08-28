/**
 * Form values for the Configure screen, parsed once and in one place.
 *
 * The schedule API speaks MINUTES PAST MIDNIGHT and the control speaks
 * `HH:MM`; getting that wrong silently sets a window nobody asked for, which
 * has already happened once by hand — see `parseWindow`/`formatWindow`.
 *
 * `Config.tsx` is deliberately untested (there is no DOM testing library in
 * this repo), so every branch worth asserting lives here instead, where
 * `config-model.test.ts` can reach it with no DOM at all.
 */

/**
 * A hand-written copy of `@trawlarr/core`'s `WorkerClass`/`WORKER_CLASSES`,
 * for the same reason `api/events.ts` keeps its own copy of `WorkerClass`:
 * `@trawlarr/core` is not a dependency of this package, and adding one to
 * reach two literal strings would be a dependency for a type.
 */
export type WorkerClass = 'transcode' | 'health';
export const WORKER_CLASSES: readonly WorkerClass[] = ['transcode', 'health'];

export const parseWorkerCount = (
  raw: string,
): { ok: true; value: number } | { ok: false; message: string } => {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, message: 'Enter a whole number of workers.' };
  }
  return { ok: true, value };
};

export const parseWindow = (
  raw: string,
): { ok: true; minutes: number } | { ok: false; message: string } => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (match === null) return { ok: false, message: 'Use HH:MM, for example 02:30.' };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false, message: 'That is not a time of day.' };
  return { ok: true, minutes: hours * 60 + minutes };
};

export const formatWindow = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

/**
 * One library's result from `POST /system/maintenance/trash-purge`, exactly
 * as the daemon reports it (`LibraryTrashSweep` in
 * `packages/server/src/library/trash-sweep.ts`) — declared structurally here
 * so a field neither this screen nor the test reads can be added on the
 * server without breaking this type.
 */
export interface PurgeSweep {
  libraryId: string;
  libraryName: string;
  retentionDays: number;
  dryRun: boolean;
  summary: {
    dirsSwept: number;
    dirsMissing: number;
    dirsRefused: number;
    removed: number;
    bytesFreed: number;
    retained: number;
    skipped: number;
    failed: number;
  };
}

/**
 * What a purge (real or a `dryRun` preview of one) did, or would do, across
 * every library it touched — the number the confirmation dialog and the
 * "purge finished" message both read from, so the two can never disagree
 * about how much was deleted.
 *
 * `failed` is carried through rather than folded into `files`: trash purge is
 * irreversible, so a run that removed 5 of 7 candidates has to say so rather
 * than quietly reporting "5 removed" as if that were the whole job.
 */
export const summarizePurge = (
  sweeps: PurgeSweep[],
): { files: number; bytes: number; failed: number } =>
  sweeps.reduce(
    (total, sweep) => ({
      files: total.files + sweep.summary.removed,
      bytes: total.bytes + sweep.summary.bytesFreed,
      failed: total.failed + sweep.summary.failed,
    }),
    { files: 0, bytes: 0, failed: 0 },
  );
