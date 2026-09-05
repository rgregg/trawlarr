/**
 * How the Diagnose tab says there is something to look at.
 *
 * The pure half, kept out of the hook so it can be tested without a DOM —
 * the same split `files-model.ts` and `config-model.ts` already use.
 */

/**
 * Above this, the badge stops counting and starts saying "a lot".
 *
 * A three-digit number in a nav badge is both unreadable at that size and
 * useless: nobody triages differently at 214 than at 99. The exact figure is
 * one click away on the screen the badge points at.
 */
const BADGE_CAP = 99;

/** What the badge prints. */
export const attentionBadge = (count: number): string =>
  count > BADGE_CAP ? `${String(BADGE_CAP)}+` : String(count);

/**
 * What a screen reader is told, which is NOT what the badge prints.
 *
 * A bare "3" appended to "Diagnose" announces as "Diagnose 3", which could
 * be a count of anything — a shortcut number, a position in the nav. The
 * badge is `aria-hidden` and this sentence replaces the whole link's label,
 * so the tab says what the number means.
 */
export const attentionLabel = (count: number | null): string | undefined => {
  if (count === null || count === 0) return undefined;
  return count === 1
    ? 'Diagnose, 1 file needs attention'
    : `Diagnose, ${String(count)} files need attention`;
};
