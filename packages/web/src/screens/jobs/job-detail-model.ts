/**
 * A job's steps, with the engine's own sentences kept intact.
 *
 * `Running ffmpeg: <reasons>` and `Skipping ffmpeg: <reason>` are the most
 * useful strings this system produces — they name the exact argument or
 * stream that made a file worth rewriting. This module's only real job is to
 * carry them to the screen unshortened.
 *
 * NOT EVERY STEP HAS ONE, and an empty one must read as none. `job_step`'s
 * `log_excerpt` column is `TEXT NOT NULL DEFAULT ''`
 * (`001_initial.sql`), and the engine writes `logExcerpt: logLines.join('\n')`
 * (`packages/engine/src/executor/run-flow.ts`) — which is `''` for any step
 * whose plugin never called `jobLog`. That is the common case for most
 * non-Execute steps, so on a real job most rows would render an empty
 * reason box if `''` were treated as a reason: exactly the visual noise this
 * screen exists to avoid, where the whole point is that the sentences that
 * DO exist stand out. `toStepRows` treats `''` the same as `null`.
 *
 * `null` is kept as a defensive case — the type allows it — but it is not
 * what production data looks like: `repo.getSteps` returns only persisted,
 * completed steps, and a completed step's `log_excerpt` is always at least
 * `''`, never absent. A step still running never reaches this array at all.
 */
export interface ApiStep {
  seq: number;
  pluginId: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string | null;
}

export interface StepRow {
  seq: number;
  label: string;
  outcome: 'ok' | 'failed' | 'running';
  durationMs: number;
  reason: string | null;
}

export const pluginLabel = (pluginId: string): string => {
  const colon = pluginId.indexOf(':');
  const hasNamespace = colon !== -1;
  const name = hasNamespace ? pluginId.slice(colon + 1) : pluginId;

  // A namespace with nothing after it — a trailing colon, or several colons
  // collapsing to an empty remainder — is not an id this can read as words.
  // The whole id is a more honest label than blanking it, the same call the
  // "cannot parse" branch below makes for a plain word.
  if (name === '') return pluginId;

  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[: ]+/)
    .filter((word) => word.length > 0);

  const isSingleLowercaseWord = words.length === 1 && words[0] === words[0]!.toLowerCase();
  if (isSingleLowercaseWord) return hasNamespace ? capitalise(words[0]!) : name;

  return words.map(capitalise).join(' ');
};

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A job's `flowHash` resolved through `GET /flows/versions/by-hash/:hash`,
 * turned into a line this screen can render without a branch of its own.
 *
 * A `404 version-not-recorded` — the answer for roughly 5,500 job rows on
 * the owner's real install, everything that ran before migration 007's
 * backfill — is NOT a failure: `JobDetail.tsx` catches it and passes
 * `versionId: null` here, same as any other lookup that came back empty.
 * Only a DIFFERENT failure (network, 500, …) is shown as one, by that
 * screen's own failure box, never by this function, which has no failure
 * state to express — it always returns a line to print.
 */
export const describeFlowVersion = (input: {
  hash: string;
  versionId: string | null;
}): { text: string; to: string | null } => {
  const shortHash = input.hash.slice(0, 8);
  if (input.versionId === null) {
    return { text: `${shortHash} — this version was not recorded`, to: null };
  }
  return { text: shortHash, to: `/flows/versions/${input.versionId}` };
};

/** Output 2 is the failure branch by convention throughout the flow contract. */
export const toStepRows = (steps: ApiStep[]): StepRow[] =>
  steps.map((step) => ({
    seq: step.seq,
    label: pluginLabel(step.pluginId),
    outcome: step.outputNumber === null ? 'running' : step.outputNumber === 2 ? 'failed' : 'ok',
    durationMs: step.durationMs,
    reason: step.logExcerpt === null || step.logExcerpt === '' ? null : step.logExcerpt,
  }));
