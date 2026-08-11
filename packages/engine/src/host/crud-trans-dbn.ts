import type { CrudMode, PluginDeps } from '@trawlarr/plugin-api';

export interface DocumentPort {
  get(collection: string, docId: string): Record<string, unknown> | undefined;
  insert(collection: string, docId: string, data: Record<string, unknown>, nowMs: number): void;
  update(collection: string, docId: string, patch: Record<string, unknown>, nowMs: number): void;
  removeOne(collection: string, docId: string): void;
}

export interface HostSettingsPort {
  setPauseAllNodes(paused: boolean): void;
  getPauseAllNodes(): boolean;
}

/** Collections that mean host state, not plugin-owned documents. */
export const HOST_COLLECTIONS = new Set(['SettingsGlobalJSONDB']);

/** Host settings keys trawlarr honours. Anything else warns rather than silently vanishing. */
const HOST_SETTING_KEYS = new Set(['pauseAllNodes']);

/**
 * Backs deps.crudTransDBN.
 *
 * Two behaviours matter. Plugin-owned collections get generic document
 * storage, because plugins invent their own names. Host collections are
 * mapped onto real trawlarr settings through a narrow allowlist — a plugin
 * asking to pause the workers genuinely pauses them, and a key we do not
 * understand produces a warning in the job log rather than a silent no-op,
 * because a silent no-op is how a plugin ends up quietly not working.
 */
export const createCrudTransDbn = (input: {
  documents: DocumentPort;
  hostSettings: HostSettingsPort;
  log: (text: string) => void;
  nowMs: () => number;
}): PluginDeps['crudTransDBN'] => {
  const handleHostSettings = (
    mode: CrudMode,
    docId: string,
    obj: Record<string, unknown>,
  ): unknown => {
    if (mode === 'getById') {
      return { _id: docId, pauseAllNodes: input.hostSettings.getPauseAllNodes() };
    }

    if (mode === 'insert' || mode === 'update') {
      for (const [key, value] of Object.entries(obj)) {
        if (!HOST_SETTING_KEYS.has(key)) {
          input.log(
            `Plugin wrote unsupported host setting "${key}" to ${docId}; ignoring. ` +
              `Supported keys: ${[...HOST_SETTING_KEYS].join(', ')}.`,
          );
          continue;
        }
        if (key === 'pauseAllNodes') input.hostSettings.setPauseAllNodes(value === true);
      }
      return undefined;
    }

    input.log(`Plugin attempted "${mode}" on host settings ${docId}; ignoring.`);
    return undefined;
  };

  return async (collection, mode, docID, obj) => {
    if (HOST_COLLECTIONS.has(collection)) {
      return handleHostSettings(mode, docID, obj);
    }

    switch (mode) {
      case 'getById':
        return input.documents.get(collection, docID);
      case 'insert':
        input.documents.insert(collection, docID, obj, input.nowMs());
        return undefined;
      case 'update':
        input.documents.update(collection, docID, obj, input.nowMs());
        return undefined;
      case 'removeOne':
        input.documents.removeOne(collection, docID);
        return undefined;
      default:
        throw new Error(
          `Unsupported crudTransDBN mode "${String(mode)}" on collection "${collection}". ` +
            `Supported modes: getById, insert, update, removeOne.`,
        );
    }
  };
};
