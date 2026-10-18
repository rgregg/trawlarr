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
  summary: string;
  library?: string;
  path?: string;
  reason?: string;
  jobId?: string;
}

export interface AlertService {
  raise(input: AlertInput): void;
  raiseFlowMessage(input: {
    destination: string;
    message: string;
    library?: string;
    path?: string;
    jobId?: string;
  }): void;
  sendTest(name: string): Promise<DeliveryResult>;
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
  const loggedErrors = new Set<string>();

  // Log text is only the error's message when it is a settings validation error, which
  // never embeds a stored value; once per distinct message so a corrupt section does not
  // write a line per job.
  const logOnce = (what: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const line = `${what}: ${message}`;
    if (loggedErrors.has(line)) return;
    loggedErrors.add(line);
    try {
      opts.log(`alerts: ${line}`);
    } catch {
      // A broken logger must not become an alert failure.
    }
  };

  const safeLog = (line: string): void => {
    try {
      opts.log(line);
    } catch {
      // see logOnce
    }
  };

  // A corrupt or hand-edited stored section makes getAlerts throw. That must mean "no
  // alerts", not an exception on the job path.
  const readSettings = (): AlertSettings => {
    try {
      return opts.settings.getAlerts();
    } catch (error) {
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
  ): void => {
    for (const d of to) {
      try {
        opts.deliverer.enqueue(targetOf(d), body);
      } catch (error) {
        logOnce(`could not queue alert for "${d.name}"`, error);
      }
    }
  };

  const baseBody = (event: string, summary: string): Record<string, unknown> => ({
    event,
    at: new Date(opts.nowMs()).toISOString(),
    summary,
  });

  const followUpSummary = (f: FollowUp): string => {
    const more = f.count > 0 ? `${f.count} more ${f.event}` : `${f.event}`;
    const other =
      f.otherCauses > 0 ? ` (${f.otherCauses} other cause${f.otherCauses === 1 ? '' : 's'})` : '';
    return f.kind === 'still-down'
      ? `${f.scope}: ${f.event} still ongoing, ${f.count} more${other}`
      : `${f.scope}: ${more}${other}`;
  };

  const sendFollowUp = (settings: AlertSettings, f: FollowUp): void => {
    const to = recipients(settings, f.event);
    if (to.length === 0) return;
    const redact = redactor(settings);
    const body = baseBody(f.event, redact(followUpSummary(f)));
    body.count = f.count;
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
          if (base !== undefined) coalescer.clear(base, input.scope);
        } else {
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
      if (stopped) return;
      try {
        const settings = readSettings();
        const d = settings.destinations.find((x) => x.name === input.destination);
        if (d === undefined || !d.enabled) {
          safeLog(
            `alerts: flow message not sent, destination "${input.destination}" is ${
              d === undefined ? 'unknown' : 'disabled'
            }`,
          );
          return;
        }
        const redact = redactor(settings);
        const body = baseBody('flow.message', redact(input.message));
        if (input.library !== undefined) body.library = input.library;
        if (input.path !== undefined) body.path = redact(input.path);
        const url = linkFor(settings, input.jobId);
        if (url !== undefined) body.url = url;
        dispatch(settings, [d], body);
      } catch (error) {
        logOnce('could not raise flow message', error);
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
