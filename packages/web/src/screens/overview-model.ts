import type { LiveState } from '../api/events.js';

/**
 * A library, exactly as `GET /api/v1/libraries` reports it.
 *
 * Only the fields this screen reads are declared — the resource carries more
 * (roots' extensions, staging and trash directories, user variables) and a
 * structural subset means adding a field to the API never breaks the UI's
 * types. The four pause fields are here because they are the whole point:
 * `pausedReason` is the daemon's machine-readable reason, `pausedBy` says
 * whether a human or the daemon did it, and `pausedExplanation` is
 * `explainPause()`'s sentence naming the consequence.
 */
export interface LibraryResource {
  id: string;
  name: string;
  roots: string[];
  flowId: string | null;
  paused: boolean;
  pausedReason: string | null;
  pausedBy: string | null;
  pausedExplanation: string | null;
}

/** `GET /api/v1/libraries/:id/stats`. */
export interface LibraryStats {
  libraryId: string;
  total: number;
  byState: Record<string, number>;
  good: number;
  missing: number;
  convergedPercent: number;
  paused: boolean;
  pausedExplanation: string | null;
  scanning: boolean;
}

export interface LibraryCard {
  id: string;
  name: string;
  convergedPercent: number;
  total: number;
  counts: Record<string, number>;
  status: 'converged' | 'working' | 'idle' | 'paused' | 'attention';
  headline: string;
  detail: string | null;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * One library, as a card.
 *
 * THE LADDER'S ORDER IS THE DESIGN: a paused library that also has failures
 * is paused first, because the pause is why nothing is happening and the
 * failures are what stopped mattering the moment it paused.
 *
 * `convergedPercent` is the daemon's number, carried through untouched. It is
 * floored there, and 100 is reserved for `good === total` exactly; recomputing
 * it here would let the UI and the CLI disagree about the one number this
 * product exists to report.
 */
export const toLibraryCard = (input: {
  library: LibraryResource;
  stats: LibraryStats;
  live: LiveState;
}): LibraryCard => {
  const { library, stats, live } = input;
  const base = {
    id: library.id,
    name: library.name,
    convergedPercent: stats.convergedPercent,
    total: stats.total,
    counts: stats.byState,
    headline: `${String(stats.convergedPercent)}% converged`,
  };

  if (library.paused) {
    // A LIBRARY THAT SAYS ONLY "paused" IS BARELY BETTER THAN ONE THAT SAYS
    // NOTHING: with no jobs, no errors and no output, a silently-stopped
    // library looks exactly like a finished one. So the reason is the card's
    // detail line — the daemon's own explanation first, the raw reason if
    // there is no explanation, and an explicit admission if there is neither,
    // because "we do not know why" is still information the operator can act
    // on and a blank line is not.
    return {
      ...base,
      status: 'paused',
      detail:
        library.pausedExplanation ?? library.pausedReason ?? 'Paused, with no reason recorded.',
    };
  }

  const seen = live.scanning[library.id];
  if (seen !== undefined) {
    return { ...base, status: 'working', detail: `Scanning — ${String(seen)} files seen` };
  }

  const running = Object.values(live.jobs).find((job) => job.libraryId === library.id);
  if (running !== undefined) {
    return { ...base, status: 'working', detail: `Running ${basename(running.path)}` };
  }

  const failed = stats.byState.failed ?? 0;
  const notConverging = stats.byState.not_converging ?? 0;
  if (failed + notConverging > 0) {
    // Both terminal states need a human: nothing re-queues them, so a
    // library sitting at 98% for ever is only explicable by naming them.
    // Neither word takes a plural "s" — "1 failed", "2 failed".
    const parts = [
      ...(failed > 0 ? [`${String(failed)} failed`] : []),
      ...(notConverging > 0 ? [`${String(notConverging)} not converging`] : []),
    ];
    return { ...base, status: 'attention', detail: parts.join(', ') };
  }

  if (stats.total > 0 && stats.good === stats.total) {
    return { ...base, status: 'converged', detail: null };
  }

  const [largestState, largestCount] = Object.entries(stats.byState)
    .filter(([state]) => state !== 'good')
    .sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0];
  return {
    ...base,
    status: 'idle',
    detail: largestCount > 0 ? `${String(largestCount)} ${largestState}` : null,
  };
};

/**
 * Convergence across the install, WEIGHTED BY FILES, not by libraries: a
 * 900-file library is not one vote next to a 100-file one.
 *
 * Floored, never rounded, and 100 reserved for `good === total` exactly —
 * the same rule the daemon applies per library. 995 good of 1000 reads 99%,
 * because 100% has to mean genuinely converged or it means nothing.
 */
export const overallConvergence = (
  cards: LibraryCard[],
): { percent: number; total: number; good: number } => {
  const total = cards.reduce((sum, card) => sum + card.total, 0);
  const good = cards.reduce(
    (sum, card) => sum + Math.round((card.convergedPercent / 100) * card.total),
    0,
  );
  // An empty install reports 0, not NaN: a fresh daemon must not greet its
  // operator with a division by zero.
  if (total === 0) return { percent: 0, total: 0, good: 0 };
  return { percent: good === total ? 100 : Math.floor((good / total) * 100), total, good };
};
