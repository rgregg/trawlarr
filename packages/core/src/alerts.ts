/**
 * Alert vocabulary and the coalescer that keeps one outage from becoming thousands of
 * messages. Pure: time arrives as `nowMs`, and nothing here sends anything.
 */

export const ALERT_EVENT_TYPES = [
  'file.failed',
  'file.not_converging',
  'node.offline',
  'library.root_missing',
  'scan.aborted',
  'library.paused',
  'hardware.check_failed',
] as const;

export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

/** Outage-style events: a condition that stands until it clears, and so has a `.recovered`. */
export type RecoverableEventType = Exclude<AlertEventType, 'file.failed' | 'file.not_converging'>;

export type AlertEventName =
  AlertEventType | `${RecoverableEventType}.recovered` | 'flow.message' | 'test';

const OUTAGE_EVENTS: ReadonlySet<string> = new Set<RecoverableEventType>([
  'node.offline',
  'library.root_missing',
  'scan.aborted',
  'library.paused',
  'hardware.check_failed',
]);

/** Only the seven daemon events coalesce; flow messages are deliberate, recoveries are news. */
function coalesces(event: AlertEventName): event is AlertEventType {
  return (ALERT_EVENT_TYPES as readonly string[]).includes(event);
}

/**
 * Reduce a failure reason to what kind of failure it was. Paths, numbers and quoted names
 * are stripped so thousands of files failing on the same missing mount share one cause;
 * the words are kept so two genuinely different failures do not.
 */
export function normalizeCause(reason: string): string {
  return reason
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"'`()]*/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface FollowUp {
  event: AlertEventName;
  scope: string;
  kind: 'summary' | 'still-down';
  count: number;
  otherCauses: number;
  examples: string[];
}

export interface Coalescer {
  offer(i: {
    event: AlertEventName;
    scope: string;
    cause: string;
    example?: string;
    nowMs: number;
  }): { send: boolean };
  due(nowMs: number): FollowUp[];
  clear(event: AlertEventName, scope: string): void;
}

const MAX_EXAMPLES = 3;

interface Group {
  event: AlertEventType;
  scope: string;
  windowEndMs: number;
  /** Outage groups outlive their first window so a long outage is not silent after message one. */
  phase: 'window' | 'repeat';
  noticeAtMs: number;
  /** Causes already announced; a repeat of one is counted, not re-sent. */
  causes: Set<string>;
  /** Individually sent causes this window; reset at each rollover so the cap is per window. */
  sentThisWindow: number;
  overflowCauses: Set<string>;
  pending: number;
  examples: string[];
}

export function createCoalescer(opts: {
  windowMs: number;
  maxCausesPerWindow: number;
  repeatMs: number;
}): Coalescer {
  // Keyed event|scope. The cause cap lives on the group because it is per scope per window;
  // the cause itself is a member, so the effective key is event|scope|cause.
  const groups = new Map<string, Group>();
  const keyOf = (event: string, scope: string): string => `${event}|${scope}`;

  const take = (g: Group): { count: number; otherCauses: number; examples: string[] } => {
    const out = { count: g.pending, otherCauses: g.overflowCauses.size, examples: g.examples };
    g.pending = 0;
    g.sentThisWindow = 0;
    g.overflowCauses = new Set();
    g.examples = [];
    return out;
  };

  return {
    offer({ event, scope, cause, example, nowMs }) {
      if (!coalesces(event)) return { send: true };
      const key = keyOf(event, scope);
      let g = groups.get(key);
      if (!g) {
        g = {
          event,
          scope,
          windowEndMs: nowMs + opts.windowMs,
          phase: 'window',
          noticeAtMs: nowMs,
          causes: new Set([cause]),
          sentThisWindow: 1,
          overflowCauses: new Set(),
          pending: 0,
          examples: [],
        };
        groups.set(key, g);
        return { send: true };
      }
      // An offer after the window closed but before `due` has flushed it is still counted:
      // starting a fresh window here would drop the pending summary on the floor.
      if (!g.causes.has(cause)) {
        // Why a cap: a loose key (one per library) floods on a mount failure, but a tight
        // one (per file) hides a second, unrelated failure behind the first for a whole
        // window. Ten distinct causes go out individually; the rest are only counted.
        if (g.sentThisWindow < opts.maxCausesPerWindow) {
          g.causes.add(cause);
          g.sentThisWindow++;
          return { send: true };
        }
        g.overflowCauses.add(cause);
      } else if (OUTAGE_EVENTS.has(g.event) && g.phase === 'window') {
        // An identical re-offer of a standing outage is the same condition, not a new
        // occurrence: counting it would send a "N more" summary at the window close for an
        // outage that is simply still down. Only the repeat phase counts them (the hourly
        // still-down).
        return { send: false };
      }
      g.pending++;
      if (
        example !== undefined &&
        g.examples.length < MAX_EXAMPLES &&
        !g.examples.includes(example)
      ) {
        g.examples.push(example);
      }
      return { send: false };
    },

    due(nowMs) {
      const out: FollowUp[] = [];
      for (const [key, g] of groups) {
        const outage = OUTAGE_EVENTS.has(g.event);
        if (g.phase === 'window') {
          if (nowMs < g.windowEndMs) continue;
          const { count, otherCauses, examples } = take(g);
          if (count > 0 || otherCauses > 0) {
            out.push({
              event: g.event,
              scope: g.scope,
              kind: 'summary',
              count,
              otherCauses,
              examples,
            });
          }
          if (outage) {
            g.phase = 'repeat';
            g.noticeAtMs = count > 0 ? nowMs : g.windowEndMs - opts.windowMs;
            // Causes stay known, so the same outage does not re-send as a "first" event.
          } else if (count > 0 || otherCauses > 0) {
            // Still happening: open the next window with the causes still known, so the next
            // failure is counted into it. Deleting here made that failure open a fresh group
            // and send at once, beside this summary — a sustained flood sent two messages
            // every window for as long as it lasted.
            g.windowEndMs = nowMs + opts.windowMs;
          } else {
            // A whole window with nothing in it: the flood is over, and the next one is news.
            groups.delete(key);
          }
          continue;
        }
        if (nowMs < g.noticeAtMs + opts.repeatMs) continue;
        if (g.pending === 0) {
          // Nobody has reported the condition for a whole repeat interval: it has gone
          // quiet, so stop repeating rather than claim it is still down.
          groups.delete(key);
          continue;
        }
        const { count, otherCauses, examples } = take(g);
        g.noticeAtMs = nowMs;
        out.push({
          event: g.event,
          scope: g.scope,
          kind: 'still-down',
          count,
          otherCauses,
          examples,
        });
      }
      return out;
    },

    clear(event, scope) {
      groups.delete(keyOf(event, scope));
    },
  };
}
