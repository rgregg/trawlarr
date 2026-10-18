import type { RecoverableEventType } from '@trawlarr/core';
import { PAUSE_PREFIX_OPERATOR } from '../daemon/library-health.js';
import type { EventBus, TrawlarrEvent } from '../daemon/events.js';
import { REFUSED_SCOPE_PREFIX, type AlertInput, type AlertService } from './alert-service.js';

/** A crash-looping container must not alert on every start: boot-time conditions wait this long. */
export const DEFAULT_STARTUP_DELAY_MS = 2 * 60_000;
/** How long a node must stay offline before it is an outage rather than a reconnect blip. */
export const DEFAULT_NODE_OFFLINE_GRACE_MS = 5 * 60_000;

const HARDWARE_SCOPE = 'hardware';
/** One scope for every refusal that names no known node: forged ids must not mint scopes. */
const UNKNOWN_REFUSAL_SCOPE = 'refused:unknown';
/** A known node is only reported refused after this many refusals inside the window. */
const REFUSALS_TO_ALERT = 3;
const REFUSAL_WINDOW_MS = 10 * 60_000;
const refusedScope = (nodeId: string): string => `${REFUSED_SCOPE_PREFIX}${nodeId}`;

export interface DaemonAlertsOptions {
  bus: EventBus;
  service: Pick<AlertService, 'raise'>;
  /** Each may return undefined for a deleted library/node/file; the id is used instead. */
  describe: {
    library(id: string): string | undefined;
    node(id: string): string | undefined;
    file(id: string): { path: string; libraryId: string } | undefined;
  };
  nowMs: () => number;
  startupDelayMs?: number;
  nodeOfflineGraceMs?: number;
  /**
   * Conditions already true when the daemon starts, read once at creation. The bus cannot say
   * these: library-health does not re-emit `library.paused` for a library already paused with
   * the same reason, and the hub emits `nodes.changed` offline only when a connection closes, so
   * a pre-paused library or a node that never reconnects would otherwise never alert.
   */
  initial?: () => {
    pausedLibraries: Array<{ id: string; reason: string }>;
    offlineNodes: Array<{ id: string }>;
  };
}

export interface DaemonAlerts {
  unsubscribe(): void;
  /**
   * Offer every standing outage to the service again, and release any that were waiting on the
   * startup delay or a node's offline grace. The coalescer only sends a "still down" repeat for an
   * outage it keeps being told about, so the daemon calls this from its tick.
   */
  reraise(): void;
}

interface Standing {
  input: AlertInput & { event: RecoverableEventType };
  /** Not raised before this time: the startup delay, plus a node's offline grace. */
  notBeforeMs: number;
  /** An alert has gone out for it; only then is a `.recovered` news. */
  raised: boolean;
}

/**
 * Turn daemon events into alerts. Two shapes:
 *
 *  - one-shot (`file.failed`, `file.not_converging`): raised straight from `job.finished`;
 *  - outages: remembered per `event|scope`, so a recovery is raised ONLY for an outage this
 *    module itself raised. A `.recovered` with no alert before it would announce the end of
 *    something nobody was told began.
 *
 * Nothing here may throw into the bus or add work to the emitting path (a job completion), so
 * every handler body is guarded and does a map update and a non-blocking `raise`.
 */
export const createDaemonAlerts = (opts: DaemonAlertsOptions): DaemonAlerts => {
  const { service, describe, nowMs } = opts;
  const startupDelayMs = opts.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  const nodeOfflineGraceMs = opts.nodeOfflineGraceMs ?? DEFAULT_NODE_OFFLINE_GRACE_MS;
  const bootMs = nowMs();
  const standing = new Map<string, Standing>();

  const keyOf = (event: string, scope: string): string => `${event}|${scope}`;
  const libraryName = (id: string): string => describe.library(id) ?? id;
  const nodeName = (id: string): string => describe.node(id) ?? id;
  // The follow-up's display name: the name or nothing, never the id the two above fall back to.
  const libraryLabel = (id: string): { label?: string } => {
    const name = describe.library(id);
    return name === undefined ? {} : { label: name };
  };
  const nodeLabel = (id: string): { label?: string } => {
    const name = describe.node(id);
    return name === undefined ? {} : { label: name };
  };

  const offer = (entry: Standing): void => {
    entry.raised = true;
    service.raise(entry.input);
  };

  /** Record an outage and raise it now unless it must wait (startup delay, node grace). */
  const begin = (input: Standing['input'], extraDelayMs = 0): void => {
    const key = keyOf(input.event, input.scope);
    const previous = standing.get(key);
    const entry: Standing = {
      input,
      // Boot-time conditions wait out the startup delay; a node's grace runs from NOW. A repeat
      // event for an outage already standing keeps its original schedule and raised flag.
      notBeforeMs:
        previous?.notBeforeMs ?? Math.max(bootMs + startupDelayMs, nowMs() + extraDelayMs),
      raised: previous?.raised ?? false,
    };
    standing.set(key, entry);
    // A repeat of an outage that is already out is left to `reraise()`: offering it on every
    // event would let a node refused every few seconds drive the service at that rate.
    if (!entry.raised && nowMs() >= entry.notBeforeMs) offer(entry);
  };

  const recover = (event: RecoverableEventType, scope: string, summary: string): void => {
    const key = keyOf(event, scope);
    const entry = standing.get(key);
    if (entry === undefined) return;
    standing.delete(key);
    if (!entry.raised) return;
    service.raise({
      event: `${event}.recovered`,
      scope,
      summary,
      ...(entry.input.library === undefined ? {} : { library: entry.input.library }),
    });
  };

  const onJobFinished = (event: Extract<TrawlarrEvent, { type: 'job.finished' }>): void => {
    if (event.state !== 'failed' && event.state !== 'not_converging') return;
    const file = describe.file(event.fileId);
    const libraryId = file?.libraryId ?? 'unknown';
    const path = file?.path ?? event.fileId;
    // Never empty: an empty reason makes the coalescer's cause fall back to the summary, which
    // is unique per file, so a flood of one failure would send ten messages instead of one.
    const reason = event.outcome.trim() === '' ? `ended ${event.state}` : event.outcome;
    const failed = event.state === 'failed';
    service.raise({
      event: failed ? 'file.failed' : 'file.not_converging',
      scope: libraryId,
      summary: failed ? `${path} failed: ${reason}` : `${path} is not converging: ${reason}`,
      reason,
      path,
      ...(file === undefined
        ? {}
        : { library: libraryName(file.libraryId), ...libraryLabel(file.libraryId) }),
      ...(event.jobId === '' ? {} : { jobId: event.jobId }),
    });
  };

  const onScanFinished = (event: Extract<TrawlarrEvent, { type: 'scan.finished' }>): void => {
    const name = libraryName(event.libraryId);
    if (event.summary.rootsUnavailable > 0) {
      // Whatever stopped the last scan is over, but "scans are completing again" would be a
      // claim of health for a scan that just found its roots gone: the aborted outage is
      // dropped without a recovery, and root_missing below is the news.
      standing.delete(keyOf('scan.aborted', event.libraryId));
      // Reported here and only here: `scan.aborted` is for a scan that threw, and one outage
      // must not send both.
      begin({
        event: 'library.root_missing',
        scope: event.libraryId,
        summary: `${name}: ${String(event.summary.rootsUnavailable)} root(s) cannot be reached, so nothing was reconciled.`,
        library: name,
        ...libraryLabel(event.libraryId),
      });
    } else {
      // A scan that finished cleanly is the library's next scan: whatever stopped the last one
      // is over.
      recover('scan.aborted', event.libraryId, `Scans of ${name} are completing again.`);
      recover('library.root_missing', event.libraryId, `${name}: its roots are reachable again.`);
    }
  };

  const beginPaused = (libraryId: string, reason: string): void => {
    // An operator's own pause is not news to the operator.
    if (reason.startsWith(PAUSE_PREFIX_OPERATOR)) return;
    begin({
      event: 'library.paused',
      scope: libraryId,
      summary: `${libraryName(libraryId)} was paused: ${reason}`,
      reason,
      library: libraryName(libraryId),
      ...libraryLabel(libraryId),
    });
  };

  /**
   * Nodes an operator revoked or deleted. Revoking disconnects the node, and that `online: false`
   * could only ever be cleared by an `online: true` a revoked node never sends, so it alerted
   * hourly until restart. Capped: ids are only added by an operator action.
   */
  const MAX_REMOVED_NODES = 1_000;
  const removedNodes = new Set<string>();

  const onNodeRemoved = (nodeId: string): void => {
    // The operator's own act: no `.recovered`, just forget the outage.
    standing.delete(keyOf('node.offline', nodeId));
    standing.delete(keyOf('node.offline', refusedScope(nodeId)));
    refusals.delete(nodeId);
    removedNodes.add(nodeId);
    if (removedNodes.size > MAX_REMOVED_NODES) {
      const oldest = removedNodes.values().next();
      if (!oldest.done) removedNodes.delete(oldest.value);
    }
  };

  const beginNodeOffline = (nodeId: string): void => {
    if (removedNodes.has(nodeId)) return;
    begin(
      {
        event: 'node.offline',
        scope: nodeId,
        ...nodeLabel(nodeId),
        summary: `Node ${nodeName(nodeId)} has been offline for over ${String(Math.round(nodeOfflineGraceMs / 60_000))} minute(s).`,
      },
      nodeOfflineGraceMs,
    );
  };

  /** Recent refusal times per KNOWN node, to tell a revoked node from one wrong-secret probe. */
  const refusals = new Map<string, number[]>();

  const onRefused = (nodeId: string | null, reason: string, authenticated: boolean): void => {
    if (nodeId === null) {
      // No standing entry: anyone can probe the socket path, and a standing entry would repeat
      // hourly until restart. Offered per refusal instead, so the coalescer's repeat lasts
      // only while refusals keep arriving.
      service.raise({
        event: 'node.offline',
        scope: UNKNOWN_REFUSAL_SCOPE,
        label: 'Unknown node',
        summary: `An unknown node was refused: ${reason}`,
        reason,
      });
      return;
    }
    if (removedNodes.has(nodeId)) return;
    // An authenticated refusal (protocol mismatch) is a fact about a node that proved who it
    // is, and such a node retries only every ~5 minutes, so a count-in-window rule would
    // never fire for it.
    if (!authenticated) {
      const at = nowMs();
      // Only the last REFUSALS_TO_ALERT times are ever needed; an unauthenticated client can
      // send these at request rate, so the list must not grow with it.
      const recent = (refusals.get(nodeId) ?? []).filter((time) => at - time <= REFUSAL_WINDOW_MS);
      recent.push(at);
      if (recent.length > REFUSALS_TO_ALERT) recent.splice(0, recent.length - REFUSALS_TO_ALERT);
      refusals.set(nodeId, recent);
      // One refusal can be anyone presenting a wrong secret for a healthy node's id.
      if (recent.length < REFUSALS_TO_ALERT) return;
    }
    // Its own scope, apart from the offline scope `nodes.changed` uses: a refused connection
    // is also detached, and sharing a key let that overwrite this entry's summary.
    begin({
      event: 'node.offline',
      scope: refusedScope(nodeId),
      ...nodeLabel(nodeId),
      summary: `Node ${nodeName(nodeId)} was refused: ${reason}`,
      reason,
    });
  };

  const onEvent = (event: TrawlarrEvent): void => {
    switch (event.type) {
      case 'job.finished':
        onJobFinished(event);
        return;
      case 'scan.finished':
        onScanFinished(event);
        return;
      case 'scan.aborted':
        begin({
          event: 'scan.aborted',
          scope: event.libraryId,
          summary: `A scan of ${libraryName(event.libraryId)} stopped: ${event.message}`,
          reason: event.message,
          library: libraryName(event.libraryId),
          ...libraryLabel(event.libraryId),
        });
        return;
      case 'library.paused':
        beginPaused(event.libraryId, event.reason);
        return;
      case 'library.resumed':
        // From any source, an operator's resume included: the library is running again either way.
        recover('library.paused', event.libraryId, `${libraryName(event.libraryId)} was resumed.`);
        return;
      case 'hardware.check_failed':
        // Clears only on restart: there is no recovery event for it.
        begin({
          event: 'hardware.check_failed',
          scope: HARDWARE_SCOPE,
          summary: `Declared hardware cannot encode: ${event.findings.join(', ')}`,
          reason: event.findings.join(', '),
        });
        return;
      case 'nodes.changed':
        if (event.online) {
          recover('node.offline', event.nodeId, `Node ${nodeName(event.nodeId)} is back online.`);
          // It authenticated: whatever refusals preceded were a different attempt.
          refusals.delete(event.nodeId);
          recover(
            'node.offline',
            refusedScope(event.nodeId),
            `Node ${nodeName(event.nodeId)} connected again.`,
          );
        } else {
          beginNodeOffline(event.nodeId);
        }
        return;
      case 'node.refused':
        onRefused(event.nodeId, event.reason, event.authenticated);
        return;
      case 'node.removed':
        onNodeRemoved(event.nodeId);
        return;
      default:
        return;
    }
  };

  try {
    const initial = opts.initial?.();
    for (const library of initial?.pausedLibraries ?? []) beginPaused(library.id, library.reason);
    for (const node of initial?.offlineNodes ?? []) beginNodeOffline(node.id);
  } catch {
    // A failing provider costs the boot-time alerts, never the daemon.
  }

  const unsubscribeBus = opts.bus.subscribe((event) => {
    try {
      onEvent(event);
    } catch {
      // A failing alert is never worth failing the job or scan that emitted the event.
    }
  });

  return {
    unsubscribe: () => {
      unsubscribeBus();
      standing.clear();
    },
    reraise: () => {
      const at = nowMs();
      // A refusal entry lasts only while refusals keep arriving; otherwise it would repeat for ever.
      for (const [nodeId, times] of [...refusals]) {
        const recent = times.filter((time) => at - time <= REFUSAL_WINDOW_MS);
        if (recent.length > 0) {
          refusals.set(nodeId, recent);
        } else {
          refusals.delete(nodeId);
          standing.delete(keyOf('node.offline', refusedScope(nodeId)));
        }
      }
      for (const entry of [...standing.values()]) {
        if (at < entry.notBeforeMs) continue;
        try {
          offer(entry);
        } catch {
          // One bad offer must not cost the others their repeat.
        }
      }
    },
  };
};

/** The brief's shape: subscribe and get the unsubscribe. Use `createDaemonAlerts` for `reraise`. */
export const subscribeDaemonAlerts = (opts: DaemonAlertsOptions): (() => void) =>
  createDaemonAlerts(opts).unsubscribe;
