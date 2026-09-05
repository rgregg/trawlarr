import type { FlowLayout } from '@trawlarr/core';
import type { ApiClient } from '../../api/client.js';

export const layoutsEqual = (left: FlowLayout, right: FlowLayout): boolean =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(
    ([id, position]) =>
      Object.hasOwn(right, id) && position.x === right[id]!.x && position.y === right[id]!.y,
  );

export interface LayoutSaveState {
  layout: FlowLayout;
  savedLayout: FlowLayout;
  saving: boolean;
  error: string | null;
}

export const hasUnsavedLayout = (state: LayoutSaveState): boolean =>
  state.saving || state.error !== null || !layoutsEqual(state.layout, state.savedLayout);

/**
 * One request at a time, coalescing newer moves while a save is in flight.
 * A late response acknowledges its own snapshot, never the latest drawing.
 */
export const createLayoutStore = (
  initial: FlowLayout,
  initialSave: (layout: FlowLayout) => Promise<FlowLayout>,
) => {
  let state: LayoutSaveState = {
    layout: initial,
    savedLayout: initial,
    saving: false,
    error: null,
  };
  let save = initialSave;
  let inFlight = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<LayoutSaveState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const persist = (): void => {
    if (inFlight || !hasUnsavedLayout(state)) return;
    inFlight = true;
    const sent = state.layout;
    update({ saving: true, error: null });
    void Promise.resolve()
      .then(() => save(sent))
      .then(
        (savedLayout) => update({ savedLayout }),
        (error: unknown) =>
          update({ error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        inFlight = false;
        update({ saving: false });
        if (state.error === null) persist();
      });
  };
  return {
    getSnapshot: (): LayoutSaveState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setLayout: (layout: FlowLayout): void => {
      if (layoutsEqual(layout, state.layout)) return;
      update({ layout });
      persist();
    },
    retry: persist,
    setSave: (next: (layout: FlowLayout) => Promise<FlowLayout>): void => {
      save = next;
    },
    refresh: (layout: FlowLayout): void => {
      if (hasUnsavedLayout(state) || layoutsEqual(layout, state.layout)) return;
      update({ layout, savedLayout: layout });
    },
  };
};

// Survives route changes and the auth gate, so an expired session cannot
// discard pending positions or start a second, competing autosave queue.
const layoutStores = new Map<string, ReturnType<typeof createLayoutStore>>();

export const saveFlowLayout = async (
  client: ApiClient,
  id: string,
  layout: FlowLayout,
): Promise<FlowLayout> =>
  (await client.put<{ layout: FlowLayout }>(`/flows/${encodeURIComponent(id)}/layout`, { layout }))
    .layout;

export const layoutStoreFor = (id: string, layout: FlowLayout, client: ApiClient) => {
  const save = (next: FlowLayout): Promise<FlowLayout> => saveFlowLayout(client, id, next);
  let store = layoutStores.get(id);
  if (store === undefined) {
    store = createLayoutStore(layout, save);
    layoutStores.set(id, store);
  } else {
    store.setSave(save);
    store.refresh(layout);
  }
  return store;
};

export const hasPendingLayouts = (): boolean =>
  [...layoutStores.values()].some((store) => hasUnsavedLayout(store.getSnapshot()));
