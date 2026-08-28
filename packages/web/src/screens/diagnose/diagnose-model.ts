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
}

const UNTROUBLED = new Set(['good']);

const NO_REASON = 'No reason was recorded for this failure.';

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
      });
    } else {
      existing.files.push(file);
      existing.totalBytes += file.sizeBytes;
    }
  }

  return [...groups.values()].sort((left, right) => right.files.length - left.files.length);
};
