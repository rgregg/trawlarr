import type { ApiFile } from '../files/files-model.js';

/**
 * Problems, not rows.
 *
 * Three files failing because a removed audio track was the longest stream
 * used to look like three mysteries — each one reporting a slightly
 * different container-duration mismatch, in seconds, down to a decimal — and
 * took days to trace back to one cause. Read as three separate failures it
 * was three investigations; read as one problem with three files it is
 * obvious in the numbers themselves. The grouping key is the engine's own
 * reason string with its numbers stripped out, because the numbers are
 * exactly what differs between files that share a cause, and nothing else
 * does.
 */
export interface ProblemGroup {
  key: string;
  title: string;
  reason: string;
  files: ApiFile[];
  totalBytes: number;
  /**
   * True when this group's files do not all share the exact same reason —
   * only the same NORMALISED one. `reason` shows one representative sentence
   * verbatim, so this is the flag that tells a reader "the others might not
   * say quite this" without them having to open every file to find out. See
   * `normaliseReason`'s doc comment for why that gap exists and is accepted.
   */
  reasonsDiffer: boolean;
}

const UNTROUBLED = new Set(['good']);

const NO_REASON = 'No reason was recorded for this failure.';

/**
 * Strips every run of digits from a reason so files that share a cause but
 * differ only in the numbers their own run produced group together — see
 * `groupProblems`'s doc comment for the duration-mismatch bug this exists
 * to catch.
 *
 * This is a blunt instrument, on purpose, and it is known to over-collapse:
 * stripping EVERY digit merges causes that differ only numerically, not just
 * ones that differ only incidentally. Two concrete ways that bites:
 *
 *  - A path embedded in the reason (several of the engine's own messages do
 *    this, e.g. `apply-report.ts`'s `The replacement for "${row.path}" could
 *    not be probed: …`) carries the episode number, so `S01E12.mkv` and
 *    `S01E13.mkv` both normalise to `SNEN.mkv` and can land in one group
 *    even though nothing about their FAILURE is related — they just happen
 *    to be adjacent episodes.
 *  - `exit code 1` and `exit code 137` both normalise to `exit code N`, and
 *    those are not the same problem: 137 is a kill signal (128 + SIGKILL),
 *    almost always an OOM, while 1 is an ordinary non-zero exit. Two
 *    genuinely distinct causes can land on one card.
 *
 * The trade is accepted deliberately rather than fixed with a cleverer rule:
 * the whole reason this screen groups at all is to turn three files each
 * reporting their own container-duration mismatch — three different decimal
 * numbers — into ONE problem, and any rule precise enough to avoid the
 * `exit code` and path collisions above would risk splitting that exact case
 * back into three. `groupProblems` narrows the blast radius by keying on
 * state as well (the two `exit code` cases would only merge if they share a
 * state) and sets `reasonsDiffer` on the group so a merged-but-different
 * group is visible rather than silently smoothed over; a file's own job
 * still has the exact, unnormalised sentence one click away.
 */
export const normaliseReason = (reason: string): string => reason.replace(/\d+(\.\d+)?/g, 'N');

const titleFor = (state: string): string => {
  switch (state) {
    case 'failed':
      return 'Failed';
    case 'held':
      return 'Held after a failed attempt';
    case 'not_converging':
      return 'Not converging';
    default:
      return 'Needs attention';
  }
};

/**
 * Groups every non-good file by (state, normalised reason). A file whose
 * reason lookup came back empty — or never came back at all, because that
 * one secondary fetch failed — is not dropped and does not get a group of
 * its own keyed on the empty string: it joins every other file with no
 * recorded reason, because to the operator "no reason" is one fact, not one
 * fact per file. `reasons[file.id]` is read with `??` for a MISSING entry
 * and then checked for `''` separately, deliberately not folded into one
 * `??` — an entry that IS present but empty (the server's actual shape for
 * "nothing recorded", see `job_step.log_excerpt`) must be caught too, and
 * `??` alone would let it through as a reason string of `''`.
 */
export const groupProblems = (input: {
  files: ApiFile[];
  reasons: Record<string, string>;
}): ProblemGroup[] => {
  const groups = new Map<string, ProblemGroup>();
  // The distinct raw (un-normalised) reasons seen per group, tracked
  // alongside `groups` rather than folded into `ProblemGroup` itself — this
  // is bookkeeping to compute `reasonsDiffer` once the group is complete,
  // not part of the shape callers get back.
  const rawReasonsSeen = new Map<string, Set<string>>();

  for (const file of input.files) {
    if (UNTROUBLED.has(file.state)) continue;
    const fetched = input.reasons[file.id] ?? '';
    const reason = fetched === '' ? NO_REASON : fetched;
    const key = `${file.state}::${normaliseReason(reason)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        title: titleFor(file.state),
        reason,
        files: [file],
        totalBytes: file.sizeBytes,
        reasonsDiffer: false,
      });
      rawReasonsSeen.set(key, new Set([reason]));
    } else {
      existing.files.push(file);
      existing.totalBytes += file.sizeBytes;
      rawReasonsSeen.get(key)!.add(reason);
    }
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.reasonsDiffer = (rawReasonsSeen.get(group.key)?.size ?? 1) > 1;
  }

  return result.sort((left, right) => right.files.length - left.files.length);
};
