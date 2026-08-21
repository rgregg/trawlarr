import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import type { LiveState } from '../api/events.js';
import {
  overallConvergence,
  toLibraryCard,
  type LibraryCard,
  type LibraryResource,
  type LibraryStats,
} from './overview-model.js';

interface WorkerRow {
  id: string;
  workerClass: string;
  hardwareType: string;
  jobId: string | null;
  path: string | null;
  pid: number | undefined;
}

interface WorkerStatus {
  paused: boolean;
  target: Record<string, number>;
  workers: WorkerRow[];
  active: number;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The worker strip: SECONDARY to convergence on purpose. How many workers are
 * running is an implementation detail of how fast the answer arrives; whether
 * the library is done is the answer.
 */
const Workers = (props: { client: ApiClient; live: LiveState }): JSX.Element => {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { client } = props;
  const stale = props.live.staleness.workers;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<WorkerStatus>('/workers');
        if (cancelled) return;
        setProblem(null);
        setStatus(next);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, stale]);

  if (problem !== null) {
    return (
      <aside className="workers">
        <h2>Workers</h2>
        <p role="alert">{problem}</p>
      </aside>
    );
  }
  if (status === null) {
    return (
      <aside className="workers">
        <h2>Workers</h2>
        <p>Loading workers…</p>
      </aside>
    );
  }

  return (
    <aside className="workers">
      <h2>Workers</h2>
      <p className="worker-target">
        {String(status.active)} running
        {status.paused ? ', pool paused' : ''} — target{' '}
        {Object.entries(status.target)
          .map(([workerClass, count]) => `${workerClass} ${String(count)}`)
          .join(', ')}
      </p>
      {status.workers.length === 0 ? (
        <p>Nothing running right now.</p>
      ) : (
        <ul className="worker-list">
          {status.workers.map((worker) => {
            const live = Object.values(props.live.jobs).find((job) => job.jobId === worker.jobId);
            return (
              <li key={worker.id}>
                <span className="worker-class">{worker.workerClass}</span>{' '}
                <span className="worker-file">
                  {worker.path === null ? 'idle' : basename(worker.path)}
                </span>
                {live?.percent !== null && live?.percent !== undefined && (
                  <span className="worker-percent"> {String(live.percent)}%</span>
                )}
                {live !== undefined && <span className="worker-stage"> {live.stage}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
};

/**
 * The screen that replaces reading `trawlarr status`.
 *
 * LIBRARY-CENTRIC BY DECISION: convergence is the headline and workers are a
 * strip beside it. The question this must answer is "is my library done?",
 * and when the answer is "it has stopped", WHY — which is why every card
 * renders the daemon's own pause explanation rather than the word "paused".
 */
export const Overview = (props: {
  client: ApiClient;
  live: LiveState;
  /**
   * Lifts the install-wide number into the header. The alternative — the
   * chrome fetching every library and every stats resource a second time to
   * render the same number 40px higher — is pure waste on a daemon that is
   * busy transcoding.
   */
  onOverall?: (overall: { percent: number; total: number; good: number }) => void;
}): JSX.Element => {
  const [cards, setCards] = useState<LibraryCard[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { client, live } = props;

  // Re-fetch on the staleness counter, never on a timer: the socket says
  // exactly when a durable fact changed, and polling would both lag and
  // hammer a daemon that is busy transcoding. `live` itself is a dependency
  // too, so an in-flight job or a running scan re-derives the cards without
  // re-fetching anything.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const libraries = await client.get<LibraryResource[]>('/libraries');
        const stats = await Promise.all(
          libraries.map(
            async (library) => await client.get<LibraryStats>(`/libraries/${library.id}/stats`),
          ),
        );
        if (cancelled) return;
        setProblem(null);
        setCards(
          libraries.map((library, index) => toLibraryCard({ library, stats: stats[index]!, live })),
        );
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, live]);

  const overallSoFar = cards === null ? null : overallConvergence(cards);
  const onOverall = props.onOverall;
  useEffect(() => {
    if (overallSoFar !== null) onOverall?.(overallSoFar);
    // Reported by value, so a re-render with the same numbers is a no-op for
    // the header.
  }, [onOverall, overallSoFar?.percent, overallSoFar?.total, overallSoFar?.good]);

  if (problem !== null) return <p role="alert">{problem}</p>;
  if (cards === null) return <p>Loading libraries…</p>;
  if (cards.length === 0) {
    // An honest empty state, not a blank page: a fresh install looks exactly
    // like a broken one otherwise.
    return <p>No libraries yet. Add one to start converging something.</p>;
  }

  const overall = overallSoFar ?? overallConvergence(cards);
  return (
    <div className="overview">
      <section>
        <h2>
          {String(overall.percent)}% converged — {String(overall.good)} of {String(overall.total)}{' '}
          files
        </h2>
        <ul className="library-cards">
          {cards.map((card) => (
            <li key={card.id} className={`card status-${card.status}`}>
              <h3>{card.name}</h3>
              <p className="headline">{card.headline}</p>
              {/* Status is TEXT as well as a class: colour is never the only
                  carrier of meaning. */}
              <p className="badge">{card.status}</p>
              {card.detail !== null && <p className="detail">{card.detail}</p>}
              <dl>
                {Object.entries(card.counts)
                  .filter(([, count]) => count > 0)
                  .map(([state, count]) => (
                    <div key={state}>
                      <dt>{state}</dt>
                      <dd>{String(count)}</dd>
                    </div>
                  ))}
              </dl>
            </li>
          ))}
        </ul>
      </section>
      <Workers client={client} live={live} />
    </div>
  );
};
