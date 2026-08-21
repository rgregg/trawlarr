import {
  validateFlowDefinition,
  type FlowDefinition,
  type FlowNodeCapabilities,
  type FlowNodeCapabilityResolver,
} from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import { createPluginLoader } from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import { createFlowRepo, type FlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createPluginRegistry, type PluginRegistry } from '../plugins/registry.js';
import type { EventBus } from './events.js';

/**
 * Owns a pause caused by flow validation. Distinct from the API's operator
 * pause (`operator: <text>`, written directly by the pause endpoint) so that
 * two independent authorities can each hold the flag without stepping on the
 * other: `checkLibraryHealth` only ever writes or clears a reason carrying
 * ITS OWN prefix, and treats any other prefix as belonging to someone else.
 * There is no schema change backing this — the prefix on the same
 * `paused_reason` column IS the ownership marker.
 */
export const PAUSE_PREFIX_FLOW = 'flow-invalid: ';

/** The prefix the pause API writes. Referenced here only to recognise it, never to write it. */
export const PAUSE_PREFIX_OPERATOR = 'operator: ';

export interface LibraryHealthResult {
  libraryId: string;
  /** Whether the library's flow is currently runnable — independent of who, if anyone, owns its pause. */
  ok: boolean;
  /** The flow-invalid reason that would apply (or does apply), or null when the flow is healthy. */
  reason: string | null;
  /** Whether this call wrote to `library.enabled`/`paused_reason`. */
  changed: boolean;
}

/**
 * Resolves a node's plugin the same three ways the executor and the flow-repo
 * validator do (first-party table, then the registry of INSTALLED plugins,
 * then the plugin id as a path through the loader), while also remembering
 * which plugin ids it could not resolve.
 *
 * The registry branch is not an optimisation, it is the whole point of
 * installing a plugin: without it, a flow that names `tdarr:something` this
 * host has installed resolves to nothing, lands in `unresolved`, and this
 * function PAUSES THE LIBRARY with "this host cannot resolve it" — the exact
 * opposite of what installing the plugin was for.
 *
 * `validateFlowDefinition` itself treats an unresolvable plugin as unknown
 * rather than wrong — a community plugin may simply not be installed on this
 * host — and one unresolvable node suppresses its own `no-start-node`
 * verdict entirely, since the missing node might have been the start. That is
 * exactly right for validating a flow someone is about to SAVE. It is not
 * right for a flow already RUNNING a library: an unresolvable plugin there
 * is not a maybe, it is the one thing wrong with the flow, so it has to be
 * reported on its own rather than inferred from validation's silence. Hence
 * this resolver is also asked, directly, which ids it could not resolve.
 */
const createResolver = (
  registry: PluginRegistry,
): {
  resolve: FlowNodeCapabilityResolver;
  unresolvedPluginIds: () => string[];
} => {
  const loader = createPluginLoader();
  const unresolved = new Set<string>();

  const capabilitiesFrom = (
    outputs: { number: number }[],
    isStartPlugin: boolean,
  ): FlowNodeCapabilities => ({
    outputNumbers: outputs.map((output) => output.number),
    isStartPlugin: isStartPlugin === true,
  });

  const resolve: FlowNodeCapabilityResolver = (node) => {
    const firstParty = FIRST_PARTY_PLUGINS[node.pluginId];
    if (firstParty !== undefined) {
      const details = firstParty.module.details();
      return capabilitiesFrom(details.outputs, details.isStartPlugin);
    }
    // An id the registry knows is loaded from the path it names. A plugin
    // whose row exists but whose FILE has gone (a source directory deleted
    // out from under an installed row) still lands in `unresolved`, which is
    // the same answer as never having installed it — one reason, one wording.
    const installed = registry.resolveAbsPath(node.pluginId);
    try {
      const loaded = loader.load(installed ?? node.pluginId);
      return capabilitiesFrom(loaded.details.outputs, loaded.details.isStartPlugin);
    } catch {
      unresolved.add(node.pluginId);
      return null;
    }
  };

  return { resolve, unresolvedPluginIds: () => [...unresolved] };
};

/**
 * What, if anything, is wrong with the flow a library is pointed at — in the
 * priority order the spec fixes, each reason naming the fix:
 *
 *  1. No flow attached at all.
 *  2. `flowId` names a flow row that no longer exists.
 *  3. The stored definition fails `validateFlowDefinition` outright. A flow
 *     that validated when it was saved can fail this later without anyone
 *     having edited it — a plugin update can change what its `details()`
 *     declares — which is exactly why this runs at daemon start and on
 *     every flow or library change, not only on save.
 *  4. A node names a plugin this host cannot resolve. Checked only once (3)
 *     finds nothing, because an unresolvable node already suppresses (3)'s
 *     own no-start-node verdict — see `createResolver`.
 */
const flowInvalidReason = (input: {
  library: LibraryRecord;
  flowRepo: FlowRepo;
  registry: PluginRegistry;
}): string | null => {
  const { library, flowRepo, registry } = input;

  if (library.flowId === null) {
    return `${PAUSE_PREFIX_FLOW}no flow attached. Run "trawlarr library set-flow".`;
  }

  const flow = flowRepo.getById(library.flowId);
  if (flow === null) {
    return (
      `${PAUSE_PREFIX_FLOW}flow "${library.flowId}" no longer exists — it was likely deleted ` +
      `while this library still pointed at it. Attach a different one with "trawlarr library ` +
      `set-flow".`
    );
  }

  const { resolve, unresolvedPluginIds } = createResolver(registry);
  const problems = validateFlowDefinition(flow.definition as FlowDefinition, resolve);
  if (problems.length > 0) {
    return `${PAUSE_PREFIX_FLOW}${problems.map((problem) => problem.message).join(' ')}`;
  }

  const unresolved = unresolvedPluginIds();
  if (unresolved.length > 0) {
    const names = unresolved.map((id) => `"${id}"`).join(', ');
    return (
      `${PAUSE_PREFIX_FLOW}flow "${flow.name}" uses plugin(s) ${names}, which this host cannot ` +
      `resolve — it is either not installed here or not on the plugin path this host loads ` +
      `from. Install it, or repoint the node at a plugin this host can run.`
    );
  }

  return null;
};

/**
 * Runs one library's flow-invalid check and reconciles `enabled`/
 * `paused_reason` against it, respecting whoever already owns the pause.
 *
 * OWNERSHIP, ENFORCED BY PREFIX: an operator who paused a library through
 * the API is never resumed here, however healthy the flow now is — this
 * function reads a `PAUSE_PREFIX_OPERATOR` reason and otherwise leaves it
 * strictly alone. Symmetrically, a flow-caused pause is the only kind this
 * function ever writes or clears.
 *
 * SELF-CLEARING, NOT SELF-DIAGNOSING: nothing here remembers "I paused this
 * for reason X" across calls — each call recomputes the reason from the
 * library and flow rows as they stand right now, so a flow that becomes
 * valid again clears its own pause the next time this runs (daemon start,
 * or the next flow/library change), with no human needing to notice.
 *
 * IDEMPOTENT: re-checking an already-paused library for the same reason
 * writes nothing and emits nothing — `changed` says so, and it is what lets
 * `library.paused` fire once per onset rather than once per tick forever.
 */
export const checkLibraryHealth = (input: {
  db: Db;
  libraryId: string;
  bus: EventBus;
}): LibraryHealthResult => {
  const { db, libraryId, bus } = input;
  const libraryRepo = createLibraryRepo(db);
  const flowRepo = createFlowRepo(db);

  const library = libraryRepo.getById(libraryId);
  if (library === null) throw new Error(`checkLibraryHealth: unknown library "${libraryId}".`);

  const reason = flowInvalidReason({ library, flowRepo, registry: createPluginRegistry(db) });
  const ok = reason === null;

  const operatorOwns =
    library.pausedReason !== null && library.pausedReason.startsWith(PAUSE_PREFIX_OPERATOR);
  if (operatorOwns) {
    // Strictly hands off: an operator pause is cleared only by the operator,
    // and is never overwritten with a flow reason even if the flow is also
    // broken — the operator's stated reason is the one an operator reading
    // it later needs to see.
    return { libraryId, ok, reason, changed: false };
  }

  if (!ok) {
    const alreadyPausedForThis = !library.enabled && library.pausedReason === reason;
    if (alreadyPausedForThis) return { libraryId, ok: false, reason, changed: false };

    libraryRepo.pause(libraryId, reason!);
    bus.emit({ type: 'library.paused', libraryId, reason: reason! });
    return { libraryId, ok: false, reason, changed: true };
  }

  const weOwnTheCurrentPause =
    !library.enabled &&
    library.pausedReason !== null &&
    library.pausedReason.startsWith(PAUSE_PREFIX_FLOW);
  if (weOwnTheCurrentPause) {
    libraryRepo.resume(libraryId);
    bus.emit({ type: 'library.resumed', libraryId });
    return { libraryId, ok: true, reason: null, changed: true };
  }

  return { libraryId, ok: true, reason: null, changed: false };
};

/** `checkLibraryHealth` over every library, in `LibraryRepo.list()` order. */
export const checkAllLibraries = (input: { db: Db; bus: EventBus }): LibraryHealthResult[] => {
  const libraryRepo = createLibraryRepo(input.db);
  return libraryRepo
    .list()
    .map((library) => checkLibraryHealth({ db: input.db, libraryId: library.id, bus: input.bus }));
};
