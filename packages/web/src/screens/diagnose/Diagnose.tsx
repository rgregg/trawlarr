import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute } from '../../shell/route.js';
import { formatBytes, type ApiFile } from '../files/files-model.js';
import { describeFailure } from '../library-form-model.js';
import { groupProblems, type ProblemGroup } from './diagnose-model.js';

// The three states worth diagnosing. `unknown`, `queued` and `running` are
// not problems — they are work still ahead of the queue — so they never
// appear here; see `Files.tsx`'s `STATES` for the full seven the Files
// screen filters on.
const PROBLEM_STATES = ['failed', 'held', 'not_converging'];

const PAGE_SIZE = 200;
const MAX_FILES_SHOWN = 5;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

interface ApiJob {
  outcome: string | null;
}

/** Every file in one state, paged in `PAGE_SIZE` chunks the same way `Files.tsx` does. */
const fetchAllForState = async (client: ApiClient, state: string): Promise<ApiFile[]> => {
  const collected: ApiFile[] = [];
  let offset = 0;
  for (;;) {
    const page = await client.get<{ total: number; items: ApiFile[] }>(
      `/files?state=${state}&limit=${String(PAGE_SIZE)}&offset=${String(offset)}`,
    );
    collected.push(...page.items);
    offset += PAGE_SIZE;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return collected;
};

/**
 * A file's most recent failure reason, or `''` if none is on record — NEVER
 * a rejected promise. This is the per-file lookup Task 4 got wrong on a
 * different screen: sharing it in a `Promise.all` with everything else let
 * one bad id blank a page whose primary data (the file list) had already
 * come back fine. Catching inline turns "the lookup failed" into the same
 * plain value as "the lookup succeeded and found nothing" — which is
 * exactly right, since `groupProblems` treats both as "no reason recorded"
 * anyway.
 */
const fetchReason = async (client: ApiClient, fileId: string): Promise<string> => {
  try {
    const page = await client.get<{ items: ApiJob[] }>(`/jobs?fileId=${fileId}&limit=1`);
    return page.items[0]?.outcome ?? '';
  } catch {
    return '';
  }
};

const RequeueControl = (props: { client: ApiClient; group: ProblemGroup }): JSX.Element => {
  const { client, group } = props;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failedFiles, setFailedFiles] = useState<ApiFile[] | null>(null);

  const onRequeueAll = useCallback((): void => {
    setFailedFiles(null);
    setProgress({ done: 0, total: group.files.length });
    void (async () => {
      const failed: ApiFile[] = [];
      for (const file of group.files) {
        try {
          await client.post(`/files/${file.id}/requeue`);
        } catch {
          failed.push(file);
        }
        setProgress((prev) => (prev === null ? prev : { ...prev, done: prev.done + 1 }));
      }
      setProgress(null);
      setFailedFiles(failed);
    })();
  }, [client, group.files]);

  const busy = progress !== null;

  return (
    <div className="problem-requeue">
      <button type="button" disabled={busy} onClick={onRequeueAll}>
        {busy
          ? `Requeuing ${String(progress.done)}/${String(progress.total)}…`
          : `Requeue all ${String(group.files.length)}`}
      </button>
      {failedFiles !== null && failedFiles.length === 0 && (
        <p className="problem-requeue-ok" role="status">
          Requeued all {String(group.files.length)} files.
        </p>
      )}
      {failedFiles !== null && failedFiles.length > 0 && (
        <p className="problem-requeue-fail" role="alert">
          {String(failedFiles.length)} of {String(group.files.length)} could not be requeued:{' '}
          {failedFiles.map((file) => basename(file.path)).join(', ')}.
        </p>
      )}
    </div>
  );
};

const ProblemCard = (props: {
  client: ApiClient;
  group: ProblemGroup;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, group, navigate } = props;
  // Every file a group holds shares one state — it is half of the grouping
  // key `diagnose-model.ts` builds — so the first file's state speaks for
  // all of them. `group.files` is never empty: `groupProblems` never
  // creates an entry without adding a file to it in the same step.
  const state = group.files[0]?.state ?? 'failed';
  const shown = group.files.slice(0, MAX_FILES_SHOWN);
  const rest = group.files.length - shown.length;

  return (
    <li className={`problem-card problem-card-state-${state}`}>
      <div className="problem-card-head">
        <h3>{group.title}</h3>
        <span className="problem-card-count">
          {String(group.files.length)} files · {formatBytes(group.totalBytes)}
        </span>
      </div>

      <div className="problem-reason-scroll">
        <p className="problem-reason">{group.reason}</p>
      </div>

      {group.reasonsDiffer && (
        // The grouping key strips every digit (see `normaliseReason`'s doc
        // comment), so files that land on one card do not always share the
        // exact same sentence — "exit code 1" and "exit code 137" both
        // become "exit code N" and can end up here together even though one
        // is an OOM kill and the other is not. `group.reason` above is only
        // ONE member's exact wording; this line is the tell that the others
        // may read differently, before anyone clicks through to check.
        <p className="problem-reason-note">
          Not every file here reports the exact same reason — open a file below to see its own.
        </p>
      )}

      <ul className="problem-files">
        {shown.map((file) => (
          <li key={file.id}>
            <Link to={`/files/${file.id}`} navigate={navigate}>
              {basename(file.path)}
            </Link>
          </li>
        ))}
        {rest > 0 && <li className="problem-files-more">and {String(rest)} more</li>}
      </ul>

      <div className="problem-card-actions">
        <Link
          to={formatRoute({ name: 'files', filters: { library: null, state, q: null } })}
          navigate={navigate}
          className="problem-inspect"
        >
          Inspect
        </Link>
        <RequeueControl client={client} group={group} />
      </div>
    </li>
  );
};

/**
 * Diagnose: problems, grouped by cause, not a list of failed rows.
 *
 * This is the idea the whole redesign was chosen for. Three files failing on
 * a real library once read as three unrelated mysteries — each reporting a
 * container duration a couple of seconds short, by a different couple of
 * seconds each time — and took days to see as the one bug it was: an audio
 * track longer than the video, on three different episodes. Grouped on the
 * reason with its numbers stripped (`diagnose-model.ts`'s `normaliseReason`)
 * those three rows become one card, and the cause is obvious on sight.
 *
 * Both of this system's real libraries are fully converged right now, which
 * makes the empty state — not the populated one — what this screen shows
 * almost always. It has to look deliberate, not like a page that failed to
 * load: `.problem-empty` and `.failure` are visually distinct on purpose.
 *
 * Deliberately untested, the same split `Files.tsx` uses over
 * `files-model.ts`: every branch that matters lives in `diagnose-model.ts`,
 * where a test can reach it without a DOM.
 */
export const Diagnose = (props: {
  client: ApiClient;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, navigate } = props;

  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [groups, setGroups] = useState<ProblemGroup[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);

    void (async () => {
      try {
        // The three problem states are equally PRIMARY data — none of them
        // is "already on screen" the way a detail panel's main record is by
        // the time it fetches a refinement — so letting any one of them
        // fail the whole `Promise.all` and fall to the failure view below is
        // correct here, not the Task 4 regression. That regression was a
        // SECONDARY per-file lookup (the reason fetch, just below) sharing a
        // `Promise.all` with data that had already arrived.
        const [failed, held, notConverging] = await Promise.all(
          PROBLEM_STATES.map(async (state) => await fetchAllForState(client, state)),
        );
        if (cancelled) return;
        const files = [...(failed ?? []), ...(held ?? []), ...(notConverging ?? [])];

        const reasons: Record<string, string> = {};
        await Promise.all(
          files.map(async (file) => {
            reasons[file.id] = await fetchReason(client, file.id);
          }),
        );
        if (cancelled) return;

        setGroups(groupProblems({ files, reasons }));
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setFailure(describeFailure(error));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  return (
    <div className="diagnose">
      <h2>Diagnose</h2>

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
          <button
            type="button"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {failure === null && loading && (
        <div className="diagnose-skeleton" aria-busy="true" aria-live="polite">
          <p className="help">Looking for problems…</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}

      {failure === null && !loading && groups.length === 0 && (
        <div className="problem-empty" role="status">
          <p className="problem-empty-headline">
            Nothing needs you — both libraries are converged.
          </p>
          <Link to="/files" navigate={navigate}>
            Browse files
          </Link>
        </div>
      )}

      {failure === null && !loading && groups.length > 0 && (
        <ul className="problem-list">
          {groups.map((group) => (
            <ProblemCard key={group.key} client={client} group={group} navigate={navigate} />
          ))}
        </ul>
      )}
    </div>
  );
};
