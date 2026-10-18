import {
  ALERT_EVENT_TYPES,
  createCoalescer,
  normalizeCause,
  type AlertEventName,
  type AlertEventType,
  type FollowUp,
  type RecoverableEventType,
} from '@trawlarr/core';
import type { AlertDestination, AlertSettings, SettingsRepo } from '../db/settings-repo.js';
import { knownSecrets } from '../db/settings-repo.js';
import type { Deliverer, DeliveryResult, DeliveryTarget } from './deliver.js';

export interface AlertInput {
  event: AlertEventType | `${RecoverableEventType}.recovered`;
  scope: string;
  /**
   * What the scope is called (a library or node NAME). Follow-ups are written from this, never
   * from `scope`: in production a scope is an id, and a summary pushed to a phone read
   * "3f2b…: library.root_missing still ongoing, 60 more".
   */
  label?: string;
  summary: string;
  library?: string;
  path?: string;
  reason?: string;
  jobId?: string;
}

/** Why a flow message did or did not go out, so the job log can say so (spec 11.5). */
export type FlowMessageStatus = 'queued' | 'unknown' | 'disabled' | 'stopped' | 'error';

export interface AlertService {
  raise(input: AlertInput): void;
  raiseFlowMessage(input: {
    destination: string;
    message: string;
    library?: string;
    path?: string;
    jobId?: string;
  }): FlowMessageStatus;
  sendTest(name: string): Promise<DeliveryResult>;
  /**
   * Forget an outage without announcing anything: for one that ended in a way no `.recovered`
   * should claim. Without it the coalescer kept the group, and the next occurrence within the
   * hour was counted rather than sent.
   */
  clear(event: RecoverableEventType, scope: string): void;
  tick(): void;
  stop(deadlineMs: number): Promise<{ dropped: number }>;
}

const WINDOW_MS = 15 * 60_000;
const REPEAT_MS = 60 * 60_000;
const MAX_CAUSES_PER_WINDOW = 10;
const REDACTED = '[redacted]';

const isAlertEvent = (event: string): event is AlertEventType =>
  (ALERT_EVENT_TYPES as readonly string[]).includes(event);

const RECOVERED_SUFFIX = '.recovered';

/** The scope prefix daemon-alerts gives a refused node, apart from its offline scope. */
export const REFUSED_SCOPE_PREFIX = 'refused:';

/** Each outage in plain words: as it stands, and as it still stands an hour later. */
const OUTAGE_WORDS: Record<RecoverableEventType, { now: string; still: string }> = {
  'library.root_missing': { now: 'roots unreachable', still: 'roots still unreachable' },
  'node.offline': { now: 'node offline', still: 'node still offline' },
  'scan.aborted': { now: 'scans aborted', still: 'scans still aborting' },
  'library.paused': { now: 'library paused', still: 'library still paused' },
  'hardware.check_failed': { now: 'hardware check failed', still: 'hardware check still failing' },
};
const REFUSED_WORDS = { now: 'node refused', still: 'node still refused' };

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The one path every alert takes: coalesce, redact, filter by destination, hand to the
 * deliverer. Nothing here may throw into a caller, because callers are the job path and
 * the daemon event bus, and an alert is never worth failing either.
 */
export const createAlertService = (opts: {
  settings: Pick<SettingsRepo, 'getAlerts'>;
  deliverer: Deliverer;
  extraSecrets: () => string[];
  nowMs: () => number;
  log: (line: string) => void;
}): AlertService => {
  const coalescer = createCoalescer({
    windowMs: WINDOW_MS,
    maxCausesPerWindow: MAX_CAUSES_PER_WINDOW,
    repeatMs: REPEAT_MS,
  });
  let stopped = false;
  // event|scope -> the library and display name of the offer, so a follow-up can say what it is
  // about. The coalescer forgets groups on its own, so the map is capped instead of tracked.
  const MAX_CONTEXT_KEYS = 1_000;
  const contextOf = new Map<string, { library?: string; label?: string }>();
  const loggedErrors = new Set<string>();

  // Never log the error's message: settings validation puts JSON.stringify(value) in it
  // (requireString/requireBoolean), so a hand-edited row holding a token would land in the
  // daemon log. The line is fixed text plus the error's class, which also dedupes it to
  // once per error name so a corrupt section does not write a line per job.
  const logOnce = (what: string, error: unknown): void => {
    const line = `${what} (${error instanceof Error ? error.name : 'non-error'})`;
    if (loggedErrors.has(line)) return;
    loggedErrors.add(line);
    try {
      opts.log(`alerts: ${line}`);
    } catch {
      // A broken logger must not become an alert failure.
    }
  };

  // A corrupt or hand-edited stored section makes getAlerts throw. That must mean "no
  // alerts", not an exception on the job path.
  let readFailed = false;
  const readSettings = (): AlertSettings => {
    readFailed = false;
    try {
      return opts.settings.getAlerts();
    } catch (error) {
      readFailed = true;
      logOnce('could not read alert settings, sending nothing', error);
      return { publicBaseUrl: '', destinations: [] };
    }
  };

  const redactor = (settings: AlertSettings): ((text: string) => string) => {
    let extra: string[] = [];
    try {
      extra = opts.extraSecrets();
    } catch (error) {
      logOnce('could not read secrets to redact', error);
    }
    // Longest first: a short secret that is a prefix of a longer one would otherwise
    // leave the longer one's tail in the clear.
    const secrets = [...new Set([...knownSecrets(settings), ...extra])]
      .filter((s) => s !== '')
      .sort((a, b) => b.length - a.length);
    return (text) => secrets.reduce((out, s) => out.split(s).join(REDACTED), text);
  };

  const linkFor = (settings: AlertSettings, jobId: string | undefined): string | undefined => {
    const base = settings.publicBaseUrl.replace(/\/+$/, '');
    if (base === '' || jobId === undefined || jobId === '') return undefined;
    return `${base}/jobs/${encodeURIComponent(jobId)}`;
  };

  const targetOf = (d: AlertDestination): DeliveryTarget => ({
    name: d.name,
    url: d.url,
    headers: d.headers,
  });

  const baseEventOf = (event: AlertEventName): AlertEventType | undefined => {
    const base = event.endsWith(RECOVERED_SUFFIX)
      ? event.slice(0, -RECOVERED_SUFFIX.length)
      : event;
    return isAlertEvent(base) ? base : undefined;
  };

  /** Destinations that want this event; a `.recovered` follows its base event's toggle. */
  const recipients = (settings: AlertSettings, event: AlertEventName): AlertDestination[] => {
    const base = baseEventOf(event);
    if (base === undefined) return [];
    return settings.destinations.filter((d) => d.enabled && d.events[base] === true);
  };

  const dispatch = (
    settings: AlertSettings,
    to: AlertDestination[],
    body: Record<string, unknown>,
  ): boolean => {
    let ok = true;
    for (const d of to) {
      try {
        opts.deliverer.enqueue(targetOf(d), body);
      } catch (error) {
        ok = false;
        logOnce('could not queue alert', error);
      }
    }
    return ok;
  };

  const baseBody = (event: string, summary: string): Record<string, unknown> => ({
    event,
    at: new Date(opts.nowMs()).toISOString(),
    summary,
  });

  /**
   * The follow-up's one line, from the name and the event's plain words. No scope (an id) and no
   * event code; and a still-down drops its count, which is mostly the daemon's minute-by-minute
   * re-offers of the same condition rather than anything that happened.
   */
  const followUpSummary = (f: FollowUp, label: string | undefined): string => {
    const other =
      f.otherCauses > 0 ? ` (${plural(f.otherCauses, 'other cause', 'other causes')})` : '';
    if (f.event === 'file.failed' || f.event === 'file.not_converging') {
      const what =
        f.event === 'file.failed'
          ? f.count === 1
            ? 'file failed'
            : 'files failed'
          : f.count === 1
            ? 'file not converging'
            : 'files not converging';
      return `${label ?? 'A library'}: ${String(f.count)} more ${what}${other}`;
    }
    const base = baseEventOf(f.event);
    if (base === undefined || base === 'file.failed' || base === 'file.not_converging') {
      return `${label ?? 'Trawlarr'}: ${String(f.count)} more${other}`;
    }
    const words = f.scope.startsWith(REFUSED_SCOPE_PREFIX) ? REFUSED_WORDS : OUTAGE_WORDS[base];
    const phrase = f.kind === 'still-down' ? words.still : words.now;
    if (base === 'hardware.check_failed') {
      return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}${other}`;
    }
    const fallback = base === 'node.offline' ? 'A node' : 'A library';
    return `${label ?? fallback}: ${phrase}${other}`;
  };

  const sendFollowUp = (settings: AlertSettings, f: FollowUp): void => {
    const to = recipients(settings, f.event);
    if (to.length === 0) return;
    const redact = redactor(settings);
    const context = contextOf.get(`${f.event}|${f.scope}`);
    const body = baseBody(f.event, redact(followUpSummary(f, context?.label)));
    body.count = f.count;
    if (context?.library !== undefined) body.library = context.library;
    if (f.examples.length > 0) body.examples = f.examples.map(redact);
    if (f.otherCauses > 0) body.otherCauses = f.otherCauses;
    dispatch(settings, to, body);
  };

  return {
    raise(input) {
      if (stopped) return;
      try {
        const settings = readSettings();
        const redact = redactor(settings);
        const recovered = input.event.endsWith(RECOVERED_SUFFIX);
        if (recovered) {
          // Without this a recurrence right after recovery would be counted into the old
          // window and stay silent, the opposite of what "it is down again" needs.
          const base = baseEventOf(input.event);
          if (base !== undefined) {
            coalescer.clear(base, input.scope);
            contextOf.delete(`${base}|${input.scope}`);
          }
        } else {
          if (input.library !== undefined || input.label !== undefined) {
            const key = `${input.event}|${input.scope}`;
            contextOf.delete(key);
            contextOf.set(key, {
              ...(input.library === undefined ? {} : { library: input.library }),
              ...(input.label === undefined ? {} : { label: input.label }),
            });
            if (contextOf.size > MAX_CONTEXT_KEYS) {
              const oldest = contextOf.keys().next();
              if (!oldest.done) contextOf.delete(oldest.value);
            }
          }
          const { send } = coalescer.offer({
            event: input.event,
            scope: input.scope,
            cause: normalizeCause(input.reason ?? input.summary),
            example: input.path === undefined ? undefined : redact(input.path),
            nowMs: opts.nowMs(),
          });
          if (!send) return;
        }
        const to = recipients(settings, input.event);
        if (to.length === 0) return;
        const body = baseBody(input.event, redact(input.summary));
        if (input.library !== undefined) body.library = input.library;
        if (input.path !== undefined) body.path = redact(input.path);
        if (input.reason !== undefined) body.reason = redact(input.reason);
        const url = linkFor(settings, input.jobId);
        if (url !== undefined) body.url = url;
        dispatch(settings, to, body);
      } catch (error) {
        logOnce('could not raise alert', error);
      }
    },

    raiseFlowMessage(input) {
      if (stopped) return 'stopped';
      try {
        const settings = readSettings();
        // An unreadable section is not "unknown destination": the author's name may be fine.
        if (readFailed) return 'error';
        const d = settings.destinations.find((x) => x.name === input.destination);
        if (d === undefined) return 'unknown';
        if (!d.enabled) return 'disabled';
        const redact = redactor(settings);
        const body = baseBody('flow.message', redact(input.message));
        if (input.library !== undefined) body.library = input.library;
        if (input.path !== undefined) body.path = redact(input.path);
        const url = linkFor(settings, input.jobId);
        if (url !== undefined) body.url = url;
        return dispatch(settings, [d], body) ? 'queued' : 'error';
      } catch (error) {
        logOnce('could not raise flow message', error);
        return 'error';
      }
    },

    async sendTest(name) {
      const fail = (error: string): DeliveryResult => ({
        ok: false,
        status: null,
        error,
        atMs: opts.nowMs(),
      });
      try {
        const d = readSettings().destinations.find((x) => x.name === name);
        if (d === undefined) return fail('unknown destination');
        return await opts.deliverer.sendNow(
          targetOf(d),
          baseBody('test', `Test alert from Trawlarr for "${d.name}"`),
        );
      } catch (error) {
        logOnce('could not send test alert', error);
        return fail('failed');
      }
    },

    clear(event, scope) {
      try {
        coalescer.clear(event, scope);
        contextOf.delete(`${event}|${scope}`);
      } catch (error) {
        logOnce('could not clear alert', error);
      }
    },

    tick() {
      if (stopped) return;
      try {
        const due = coalescer.due(opts.nowMs());
        if (due.length === 0) return;
        const settings = readSettings();
        for (const f of due) sendFollowUp(settings, f);
      } catch (error) {
        logOnce('could not send follow-ups', error);
      }
    },

    async stop(deadlineMs) {
      stopped = true;
      try {
        return await opts.deliverer.drain(deadlineMs);
      } catch (error) {
        logOnce('could not drain alerts', error);
        return { dropped: 0 };
      }
    },
  };
};
