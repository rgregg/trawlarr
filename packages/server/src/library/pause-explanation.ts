import { PAUSE_PREFIX_FLOW, PAUSE_PREFIX_OPERATOR } from '../daemon/library-health.js';
import type { LibraryRecord } from '../db/library-repo.js';

/** Who holds a library's pause, decided from the reason's prefix (see `library-health.ts`). */
export type PauseOwner = 'flow' | 'operator' | 'unknown';

export interface PauseExplanation {
  /** Who owns the pause, from the reason's prefix. */
  owner: PauseOwner;
  /** The stored `paused_reason`, verbatim — never reworded, never truncated. */
  reason: string;
  /**
   * The same fact, written for a human who is looking at a library that has
   * stopped converging and does not yet know it.
   */
  explanation: string;
}

/**
 * Turn `library.paused_reason` into something an operator can act on.
 *
 * This exists because of a gap that was real: Task 9 made the daemon PAUSE a
 * library whose flow cannot run, and record exactly why — and then nothing
 * showed it to anybody. A library that silently stops converging looks
 * identical to a library that has finished converging: no files run, no jobs
 * appear, no errors are printed. The only difference is a column nothing
 * read.
 *
 * So every explanation here names the CONSEQUENCE, not just the rule, in the
 * voice the flow validator already uses ("…the executor indexes nodes by id,
 * so all but one of these is silently dropped…"). What an operator needs to
 * know is not "enabled is 0"; it is "nothing in this library will be claimed
 * until you fix this, new files will keep piling up behind it, and the files
 * already marked good will keep reporting good whether or not they still
 * match the flow you intended".
 */
export const explainPause = (library: LibraryRecord): PauseExplanation | null => {
  // `enabled` is the flag the supervisor actually reads (`eligibleLibrariesFor`
  // skips a library that is not enabled), so it — not the presence of a reason
  // — decides whether this library is paused at all.
  if (library.enabled) return null;

  const reason = library.pausedReason ?? '';

  if (reason.startsWith(PAUSE_PREFIX_FLOW)) {
    const detail = reason.slice(PAUSE_PREFIX_FLOW.length);
    return {
      owner: 'flow',
      reason,
      explanation:
        `Library "${library.name}" is paused because its flow cannot be run as written: ` +
        `${detail} Until that is fixed nothing in this library converges — no file is claimed, ` +
        `no job is started, and every new file a scan finds joins a queue that nothing is ` +
        `draining, while the files already recorded "good" keep reporting good whether or not ` +
        `they still match the flow you meant to run. Fix the flow (or attach a different one) ` +
        `and the pause clears itself on the next health check; resuming without fixing it is ` +
        `refused, because a library resumed into an unrunnable flow produces ten thousand ` +
        `identical failures instead of one legible one.`,
    };
  }

  if (reason.startsWith(PAUSE_PREFIX_OPERATOR)) {
    const detail = reason.slice(PAUSE_PREFIX_OPERATOR.length);
    return {
      owner: 'operator',
      reason,
      explanation:
        `Library "${library.name}" was paused by an operator: ${detail} Scanning continues, so ` +
        `new files are still discovered and queued, but nothing is claimed and nothing converges ` +
        `until someone resumes it — the backlog grows silently in the meantime, and no other ` +
        `part of trawlarr will lift this pause for you.`,
    };
  }

  return {
    owner: 'unknown',
    reason,
    explanation:
      `Library "${library.name}" is paused${reason === '' ? '' : `: ${reason}`}. No reason was ` +
      `recorded that trawlarr recognises, so it cannot say who paused it or what would clear ` +
      `it — but the effect is the same either way: nothing in this library is claimed and ` +
      `nothing converges while it stays paused. Resume it explicitly once you know why it is ` +
      `like this.`,
  };
};
