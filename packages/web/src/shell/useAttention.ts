import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';
import { PROBLEM_STATES } from '../screens/diagnose/diagnose-model.js';

/**
 * How many files need a human, for the badge on the Diagnose tab.
 *
 * THIS IS A FETCH IN THE SHELL, which this file needs to justify: `App.tsx`
 * deliberately dropped an overall convergence figure from the header rather
 * than add one, on the grounds that it duplicated a request the Watch screen
 * was already making for a number the operator could read there anyway.
 *
 * A badge is the opposite case. Its entire purpose is to say something about
 * a screen you are NOT looking at — Diagnose cannot report its own count to
 * a nav bar it is not mounted under, and an operator with four failed files
 * and no reason to open the tab is exactly who this is for. There is no
 * screen already fetching this, so it is not a duplicate.
 *
 * `limit=1` on each state: the response's `total` is the count of the whole
 * filtered set, so this is three small requests rather than three paged
 * walks of every problem file. `Diagnose.tsx` pages the same states in full
 * because it renders them; this only counts them.
 *
 * THE STATES COME FROM `diagnose-model.ts`, not from a second list here. A
 * badge that counts a different set than the screen shows is worse than no
 * badge: it sends the operator to a tab that then tells them nothing is
 * wrong, and after that they stop believing it.
 */
export const useAttention = (client: ApiClient, staleKey: number): number | null => {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const totals = await Promise.all(
          PROBLEM_STATES.map(async (state) => {
            const page = await client.get<{ total: number }>(`/files?state=${state}&limit=1`);
            return page.total;
          }),
        );
        if (cancelled) return;
        setCount(totals.reduce((sum, total) => sum + total, 0));
      } catch {
        // No badge rather than a wrong one, and nothing said out loud: the
        // nav is not the place to report that a count could not be fetched,
        // and every screen it links to reports its own failures already.
        if (!cancelled) setCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-counted when the socket says a job ended (a file can enter `failed`
    // or `held` only when one does) or a library changed (a scan can bring
    // new files in). Never on a timer.
  }, [client, staleKey]);

  return count;
};
