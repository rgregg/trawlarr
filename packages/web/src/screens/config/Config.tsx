import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import type { LiveState } from '../../api/events.js';
import { Link } from '../../shell/Link.js';
import { formatRoute, type ConfigTab } from '../../shell/route.js';
import { formatBytes } from '../files/files-model.js';
import {
  formatWindow,
  parseWindow,
  parseWorkerCount,
  summarizePurge,
  WORKER_CLASSES,
  type PurgeSweep,
  type WorkerClass,
} from './config-model.js';
import { Libraries } from './Libraries.js';
import { describeFailure } from './library-form-model.js';

const TABS: Array<{ tab: ConfigTab; label: string }> = [
  { tab: 'workers', label: 'Workers' },
  { tab: 'libraries', label: 'Libraries' },
  { tab: 'plugins', label: 'Plugins' },
  { tab: 'system', label: 'System' },
];

const WORKER_CLASS_LABELS: Record<WorkerClass, string> = {
  transcode: 'Transcode',
  health: 'Health check',
};

/* --- workers -------------------------------------------------------------- */

interface WorkersResource {
  paused: boolean;
  /** What the schedule says RIGHT NOW — may differ from `baseCounts` while a window is active. */
  target: Record<WorkerClass, number>;
  /** The configured, permanent count. This is the number this tab edits. */
  baseCounts: Record<WorkerClass, number>;
  active: number;
}

/**
 * The one control that starts and stops every transcode this daemon will
 * ever run. There is no CLI command for it either — until this screen, the
 * only way to change it was a raw `PUT /workers/counts` with curl.
 *
 * `target` is shown but never edited here: it is what an active schedule
 * window is asking for at this instant, and can differ from `baseCounts`
 * (the number this form writes) whenever one is in force. Labelling the two
 * separately is deliberate — see `GET /workers`'s doc comment on the server.
 */
const WorkersTab = (props: { client: ApiClient; live: LiveState }): JSX.Element => {
  const { client } = props;
  const stale = props.live.staleness.workers;

  const [data, setData] = useState<WorkersResource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inputs, setInputs] = useState<Record<WorkerClass, string>>({ transcode: '', health: '' });
  // Seeds `inputs` from the server exactly once. A ref, not state that the
  // fetch effect depends on: re-seeding on every re-fetch would overwrite
  // whatever the operator is mid-typing the moment a `workers.changed`
  // socket frame arrives.
  const seeded = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<WorkersResource>('/workers');
        if (cancelled) return;
        setProblem(null);
        setData(next);
        if (!seeded.current) {
          seeded.current = true;
          setInputs({
            transcode: String(next.baseCounts.transcode),
            health: String(next.baseCounts.health),
          });
        }
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, stale, attempt]);

  const parsed = WORKER_CLASSES.map(
    (workerClass) => [workerClass, parseWorkerCount(inputs[workerClass])] as const,
  );
  const fieldProblems = Object.fromEntries(
    parsed
      .filter((entry): entry is [WorkerClass, { ok: false; message: string }] => !entry[1].ok)
      .map(([workerClass, result]) => [workerClass, result.message]),
  );
  const invalid = Object.keys(fieldProblems).length > 0;

  const save = async (): Promise<void> => {
    if (invalid) return;
    setSaving(true);
    setFailure(null);
    try {
      const body = Object.fromEntries(
        parsed.map(([workerClass, result]) => [workerClass, (result as { value: number }).value]),
      );
      const next = await client.put<WorkersResource>('/workers/counts', body);
      setData(next);
      setInputs({
        transcode: String(next.baseCounts.transcode),
        health: String(next.baseCounts.health),
      });
    } catch (error) {
      // The typed counts are NOT reset on failure — an operator who typed
      // "0" to stop a runaway job must still see "0" on screen even if the
      // save failed, or the form is lying about what state it is in.
      setFailure(describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  if (problem !== null && data === null) {
    return (
      <div role="alert" className="failure">
        <strong>Could not load worker counts</strong>
        <p className="verbatim">{problem}</p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (data === null) return <p>Loading worker counts…</p>;

  return (
    <section className="workers-tab">
      {problem !== null && (
        // A re-fetch failed after the first load already succeeded: the
        // numbers on screen are stale, not wrong, so they stay up rather
        // than being replaced by a blank screen.
        <p role="alert" className="stale-note">
          Could not refresh: {problem}. Showing the last counts this screen loaded.
        </p>
      )}

      <p className="detail">
        Running right now (what the schedule is asking for): transcode{' '}
        {String(data.target.transcode)}, health check {String(data.target.health)},{' '}
        {String(data.active)} active.
      </p>

      <div className="worker-count-fields">
        {WORKER_CLASSES.map((workerClass) => (
          <div key={workerClass} className="worker-count-field">
            <label htmlFor={`worker-count-${workerClass}`}>
              {WORKER_CLASS_LABELS[workerClass]} workers
            </label>
            <input
              id={`worker-count-${workerClass}`}
              inputMode="numeric"
              value={inputs[workerClass]}
              aria-describedby={
                fieldProblems[workerClass] !== undefined
                  ? `worker-count-${workerClass}-problem`
                  : undefined
              }
              onChange={(event) => {
                setInputs((current) => ({ ...current, [workerClass]: event.target.value }));
              }}
            />
            {fieldProblems[workerClass] !== undefined && (
              <p id={`worker-count-${workerClass}-problem`} className="problems">
                {fieldProblems[workerClass]}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Verbatim, per the brief: a measured result on this exact hardware,
          not a general recommendation. */}
      <p className="help worker-count-warning">
        Raising transcode workers from 1 to 3 measurably reduced throughput on this hardware (6
        vCPU, one GPU).
      </p>

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}

      <div className="row-actions">
        <button type="button" disabled={saving || invalid} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save worker counts'}
        </button>
      </div>
    </section>
  );
};

/* --- plugins ---------------------------------------------------------------
   Sources only — installing a plugin means TRUSTING code this host will run,
   which is exactly the kind of decision `POST /plugins/sources` already
   states out loud (`PLUGIN_TRUST_CONSEQUENCE`) and this tab does not add a
   second way to make it. Adding a source is not built here either: it is
   a one-shot CLI-shaped operation this task did not scope, so the tab reads
   what is already configured and lets each one be synced again. */

interface PluginSourceResource {
  id: string;
  url: string;
  kind: 'tarball' | 'local';
  enabled: boolean;
  lastSyncedAtMs: number | null;
  installedCount: number;
  sync: {
    runId: number | null;
    running: boolean;
    finishedAtMs: number | null;
    report: { installed?: number; skipped?: number } | null;
    error: { code: string; message: string } | null;
  };
}

const formatWhen = (ms: number | null): string =>
  ms === null ? 'never' : new Date(ms).toISOString();

const PluginSourceRow = (props: {
  client: ApiClient;
  source: PluginSourceResource;
  onChanged: (source: PluginSourceResource) => void;
}): JSX.Element => {
  const { client, source } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);

  const sync = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await client.post(`/plugins/sources/${source.id}/sync`, {});
      // The sync was STARTED, not finished — 202, same as everywhere else
      // this daemon accepts long work. Poll this one source until the run
      // it just kicked off stops running, then report whatever it landed on.
      for (;;) {
        await new Promise((resolve) => {
          (globalThis as { setTimeout: typeof setTimeout }).setTimeout(resolve, 1500);
        });
        const sources = await client.get<PluginSourceResource[]>('/plugins/sources');
        const found = sources.find((candidate) => candidate.id === source.id);
        if (found === undefined) return;
        props.onChanged(found);
        if (!found.sync.running) break;
      }
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card">
      <h3>{source.id}</h3>
      <p className="detail">
        {source.kind === 'tarball' ? 'Tarball' : 'Local directory'}: {source.url}
      </p>
      <p className="detail">
        {String(source.installedCount)} plugin(s) installed. Last synced{' '}
        {formatWhen(source.lastSyncedAtMs)}.
      </p>
      {source.sync.running && (
        <p className="detail">Sync running (run {String(source.sync.runId)})…</p>
      )}
      {!source.sync.running && source.sync.error !== null && (
        <p role="alert" className="verbatim">
          Last sync failed: {source.sync.error.message}
        </p>
      )}
      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
      <div className="row-actions">
        <button type="button" disabled={busy || source.sync.running} onClick={() => void sync()}>
          {busy || source.sync.running ? 'Syncing…' : 'Sync'}
        </button>
      </div>
    </li>
  );
};

const PluginsTab = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [sources, setSources] = useState<PluginSourceResource[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<PluginSourceResource[]>('/plugins/sources');
        if (cancelled) return;
        setProblem(null);
        setSources(next);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const replace = (source: PluginSourceResource): void => {
    setSources((current) =>
      (current ?? []).map((candidate) => (candidate.id === source.id ? source : candidate)),
    );
  };

  if (problem !== null && sources === null) {
    return (
      <div role="alert" className="failure">
        <strong>Could not load plugin sources</strong>
        <p className="verbatim">{problem}</p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (sources === null) return <p>Loading plugin sources…</p>;

  return (
    <section className="plugins-tab">
      {sources.length === 0 ? (
        <p>
          No plugin sources are configured. Add one with <code>trawlarr plugins sources add</code> —
          this screen syncs what already exists rather than adding a new one, since adding a source
          is the moment this host starts trusting code it did not write.
        </p>
      ) : (
        <ul className="library-cards">
          {sources.map((source) => (
            <PluginSourceRow key={source.id} client={client} source={source} onChanged={replace} />
          ))}
        </ul>
      )}
    </section>
  );
};

/* --- system ----------------------------------------------------------------
   Schedule, trash retention/purge, and a read-only hardware/ffmpeg block.
   `GET /system/health` (used for a container's liveness probe) carries no
   hardware field; the hardware findings this block shows come from
   `GET /system/version`, which is where the startup preflight actually
   records them. */

interface ScheduleWindowResource {
  id: string;
  days: number[];
  startMinute: number;
  endMinute: number;
  counts: Partial<Record<WorkerClass, number>>;
}

interface ScheduleResource {
  timezone: string;
  baseCounts: Record<WorkerClass, number>;
  windows: ScheduleWindowResource[];
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const newWindowId = (): string => {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID !== undefined) return cryptoObj.randomUUID();
  // A browser old enough to lack `randomUUID` still needs a unique-enough id
  // for a list key and a PUT body; this is never persisted as a security
  // token, so `Math.random` is an acceptable fallback here only.
  return `window-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const ScheduleSection = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [schedule, setSchedule] = useState<ScheduleResource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);

  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState('00:00');
  const [end, setEnd] = useState('06:00');
  const [transcodeOverride, setTranscodeOverride] = useState('');
  const [healthOverride, setHealthOverride] = useState('');
  const [draftProblem, setDraftProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<ScheduleResource>('/system/schedule');
        if (cancelled) return;
        setProblem(null);
        setSchedule(next);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const write = async (next: ScheduleResource): Promise<void> => {
    setSaving(true);
    setFailure(null);
    try {
      const saved = await client.put<ScheduleResource>('/system/schedule', next);
      setSchedule(saved);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  const addWindow = (): void => {
    if (schedule === null) return;
    const startResult = parseWindow(start);
    const endResult = parseWindow(end);
    if (!startResult.ok) {
      setDraftProblem(startResult.message);
      return;
    }
    if (!endResult.ok) {
      setDraftProblem(endResult.message);
      return;
    }
    const counts: Partial<Record<WorkerClass, number>> = {};
    if (transcodeOverride.trim() !== '') {
      const parsed = parseWorkerCount(transcodeOverride);
      if (!parsed.ok) {
        setDraftProblem(`Transcode override: ${parsed.message}`);
        return;
      }
      counts.transcode = parsed.value;
    }
    if (healthOverride.trim() !== '') {
      const parsed = parseWorkerCount(healthOverride);
      if (!parsed.ok) {
        setDraftProblem(`Health check override: ${parsed.message}`);
        return;
      }
      counts.health = parsed.value;
    }
    if (Object.keys(counts).length === 0) {
      setDraftProblem('Set at least one worker-class count this window should override.');
      return;
    }
    setDraftProblem(null);
    const window: ScheduleWindowResource = {
      id: newWindowId(),
      days,
      startMinute: startResult.minutes,
      endMinute: endResult.minutes,
      counts,
    };
    void write({ ...schedule, windows: [...schedule.windows, window] });
  };

  const removeWindow = (id: string): void => {
    if (schedule === null) return;
    void write({ ...schedule, windows: schedule.windows.filter((w) => w.id !== id) });
  };

  if (problem !== null && schedule === null) {
    return (
      <div role="alert" className="failure">
        <strong>Could not load the schedule</strong>
        <p className="verbatim">{problem}</p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (schedule === null) return <p>Loading schedule…</p>;

  return (
    <div className="config-section">
      <h3>Schedule</h3>
      <p className="help">
        Outside any window, worker counts are whatever the Workers tab has saved. A window overrides
        the classes it names — for example, more transcode workers overnight — for as long as the
        current time (in {schedule.timezone}) falls inside it.
      </p>

      {schedule.windows.length === 0 ? (
        <p className="detail">No windows configured — the base counts always apply.</p>
      ) : (
        <ul className="schedule-windows">
          {schedule.windows.map((window) => (
            <li key={window.id} className="card">
              <p className="detail">
                {window.days.length === 0
                  ? 'Every day'
                  : window.days.map((day) => DAY_LABELS[day]).join(', ')}
                , {formatWindow(window.startMinute)}–{formatWindow(window.endMinute)}
              </p>
              <p className="detail">
                {Object.entries(window.counts)
                  .map(
                    ([cls, count]) =>
                      `${WORKER_CLASS_LABELS[cls as WorkerClass]}: ${String(count)}`,
                  )
                  .join(', ')}
              </p>
              <div className="row-actions">
                <button type="button" disabled={saving} onClick={() => removeWindow(window.id)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h4>Add a window</h4>
      <fieldset className="schedule-add">
        <legend className="help">Days (none selected means every day)</legend>
        <div className="schedule-days">
          {DAY_LABELS.map((label, index) => (
            <label key={label} className="switch">
              <input
                type="checkbox"
                checked={days.includes(index)}
                onChange={(event) => {
                  setDays((current) =>
                    event.target.checked
                      ? [...current, index].sort()
                      : current.filter((d) => d !== index),
                  );
                }}
              />
              {label}
            </label>
          ))}
        </div>

        <label htmlFor="schedule-start">Start (HH:MM)</label>
        <input
          id="schedule-start"
          value={start}
          onChange={(event) => {
            setStart(event.target.value);
          }}
        />

        <label htmlFor="schedule-end">End (HH:MM)</label>
        <input
          id="schedule-end"
          value={end}
          onChange={(event) => {
            setEnd(event.target.value);
          }}
        />

        <label htmlFor="schedule-transcode">Transcode workers during this window</label>
        <input
          id="schedule-transcode"
          placeholder="unchanged"
          value={transcodeOverride}
          onChange={(event) => {
            setTranscodeOverride(event.target.value);
          }}
        />

        <label htmlFor="schedule-health">Health-check workers during this window</label>
        <input
          id="schedule-health"
          placeholder="unchanged"
          value={healthOverride}
          onChange={(event) => {
            setHealthOverride(event.target.value);
          }}
        />

        {draftProblem !== null && <p className="problems">{draftProblem}</p>}

        <div className="row-actions">
          <button type="button" disabled={saving} onClick={addWindow}>
            {saving ? 'Saving…' : 'Add window'}
          </button>
        </div>
      </fieldset>

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </div>
  );
};

type PurgePreview =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; sweeps: PurgeSweep[] }
  | { kind: 'problem'; message: string };

/**
 * Trash purge is the one irreversible action on this whole screen: it
 * deletes the pre-transcode originals that are the only way to undo a bad
 * conversion, and this host currently holds hundreds of gigabytes of them.
 * The button never fires on one click — it previews exactly what would go
 * (a `dryRun` sweep, the same code path a real purge takes) and only the
 * SECOND, explicit confirmation performs it.
 */
const TrashSection = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [preview, setPreview] = useState<PurgePreview>({ kind: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeSweep[] | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);

  const loadPreview = async (): Promise<void> => {
    setPreview({ kind: 'loading' });
    setPurgeResult(null);
    try {
      const answer = await client.post<{ sweeps: PurgeSweep[] }>(
        '/system/maintenance/trash-purge',
        {
          dryRun: true,
        },
      );
      setPreview({ kind: 'ready', sweeps: answer.sweeps });
    } catch (error) {
      setPreview({ kind: 'problem', message: describeFailure(error).message });
    }
  };

  useEffect(() => {
    // Loaded once on mount; the operator re-checks explicitly (below) rather
    // than this section polling a filesystem walk on a timer.
    void loadPreview();
  }, [client]);

  const purge = async (): Promise<void> => {
    setPurging(true);
    setFailure(null);
    try {
      const answer = await client.post<{ sweeps: PurgeSweep[] }>(
        '/system/maintenance/trash-purge',
        {},
      );
      setPurgeResult(answer.sweeps);
      setConfirming(false);
      await loadPreview();
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="config-section trash-section">
      <h3>Trash</h3>
      <p className="help">
        Retention is set per library, by the longest <code>trashRetentionDays</code> any Replace
        Original File node in that library&rsquo;s flow declares — there is no separate retention
        setting here to edit. This purges whatever has already outlived that window.
      </p>

      {preview.kind === 'loading' && <p className="detail">Checking what is purgeable…</p>}
      {preview.kind === 'problem' && (
        <div role="alert" className="failure">
          <strong>Could not check trash</strong>
          <p className="verbatim">{preview.message}</p>
          <button type="button" onClick={() => void loadPreview()}>
            Retry
          </button>
        </div>
      )}

      {preview.kind === 'ready' &&
        (() => {
          const totals = summarizePurge(preview.sweeps);
          if (totals.files === 0) {
            return <p className="detail">Nothing is currently past its retention window.</p>;
          }
          return (
            <>
              <p className="trash-total">
                Purging now would <strong>permanently delete {String(totals.files)} file(s)</strong>{' '}
                totalling <strong>{formatBytes(totals.bytes)}</strong> across{' '}
                {String(preview.sweeps.length)} librar{preview.sweeps.length === 1 ? 'y' : 'ies'}.
                {totals.failed > 0 &&
                  ` ${String(totals.failed)} entr(y/ies) could not be checked and will be reported as failed.`}
              </p>

              {!confirming ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(true);
                  }}
                >
                  Purge now…
                </button>
              ) : (
                <div role="alert" className="failure trash-confirm">
                  <strong>This cannot be undone.</strong>
                  <p>
                    {String(totals.files)} file(s) ({formatBytes(totals.bytes)}) will be deleted
                    permanently. They are the only remaining copies of whatever they replaced.
                  </p>
                  <div className="row-actions">
                    <button type="button" disabled={purging} onClick={() => void purge()}>
                      {purging
                        ? 'Purging…'
                        : `Yes, permanently delete ${String(totals.files)} file(s)`}
                    </button>
                    <button
                      type="button"
                      disabled={purging}
                      onClick={() => {
                        setConfirming(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          );
        })()}

      {purgeResult !== null && (
        <p role="status" className="detail">
          Purge finished: removed {String(summarizePurge(purgeResult).files)} file(s), freed{' '}
          {formatBytes(summarizePurge(purgeResult).bytes)}.
        </p>
      )}

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </div>
  );
};

interface VersionResource {
  binaries: Record<string, { path: string; resolved: boolean }>;
  hardware: Array<{ type: string; reason: string }> | unknown[];
}

const HardwareSection = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [version, setVersion] = useState<VersionResource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.get<VersionResource>('/system/version');
        if (cancelled) return;
        setProblem(null);
        setVersion(next);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  if (problem !== null && version === null) {
    return (
      <div role="alert" className="failure">
        <strong>Could not load hardware/ffmpeg status</strong>
        <p className="verbatim">{problem}</p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (version === null) return <p>Loading hardware/ffmpeg status…</p>;

  return (
    <div className="config-section">
      <h3>Hardware &amp; ffmpeg</h3>
      <p className="help">
        Read-only. Hardware here is DECLARED, never detected — this is what the startup preflight
        found when it checked that declaration against what the configured ffmpeg can really do.
      </p>
      <dl className="card dl">
        {Object.entries(version.binaries).map(([name, info]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {info.path} — {info.resolved ? 'resolves' : 'does not resolve'}
            </dd>
          </div>
        ))}
      </dl>
      {version.hardware.length === 0 ? (
        <p className="detail">No hardware findings — every declared type checked out.</p>
      ) : (
        <ul className="problems">
          {(version.hardware as Array<{ type: string; reason: string }>).map((finding) => (
            <li key={finding.type}>
              {finding.type}: {finding.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const SystemTab = (props: { client: ApiClient }): JSX.Element => (
  <section className="system-tab">
    <ScheduleSection client={props.client} />
    <TrashSection client={props.client} />
    <HardwareSection client={props.client} />
  </section>
);

/* --- shell ------------------------------------------------------------------ */

/**
 * The Configure screen: four tabs behind one `?tab=` route.
 *
 * Deliberately untested, the same split every other screen in this package
 * uses: `config-model.ts` holds the parsing and the arithmetic a test can
 * reach without a DOM, and this file is a thin renderer over it.
 */
export const Config = (props: {
  client: ApiClient;
  live: LiveState;
  tab: ConfigTab;
  navigate: (to: string) => void;
}): JSX.Element => (
  <section className="config">
    <nav className="config-tabs" aria-label="Configure sections">
      {TABS.map((entry) => (
        <Link
          key={entry.tab}
          to={formatRoute({ name: 'config', tab: entry.tab })}
          navigate={props.navigate}
          className="config-tab-link"
          aria-current={props.tab === entry.tab ? 'page' : undefined}
        >
          {entry.label}
        </Link>
      ))}
    </nav>

    {props.tab === 'workers' && <WorkersTab client={props.client} live={props.live} />}
    {props.tab === 'libraries' && (
      <Libraries client={props.client} live={props.live} navigate={props.navigate} />
    )}
    {props.tab === 'plugins' && <PluginsTab client={props.client} />}
    {props.tab === 'system' && <SystemTab client={props.client} />}
  </section>
);
