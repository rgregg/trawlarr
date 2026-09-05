import { describe, expect, it, vi } from 'vitest';
import type { FlowLayout } from '@trawlarr/core';
import { createApiClient } from '../../api/client.js';
import {
  createLayoutStore,
  hasUnsavedLayout,
  layoutsEqual,
  saveFlowLayout,
} from './flow-layout-model.js';

const first: FlowLayout = { start: { x: 40, y: 40 } };
const second: FlowLayout = { start: { x: 200, y: 120 } };
const third: FlowLayout = { start: { x: -50, y: 340 }, other: { x: 200, y: 500 } };

const deferred = () => {
  let resolve!: (layout: FlowLayout) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FlowLayout>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('persistent flow layout', () => {
  it('reads stored coordinates without writing or depending on object key order', () => {
    const save = vi.fn(async (layout: FlowLayout) => layout);
    const store = createLayoutStore(third, save);
    expect(store.getSnapshot().layout).toEqual(third);
    expect(hasUnsavedLayout(store.getSnapshot())).toBe(false);
    store.setLayout({ other: { x: 200, y: 500 }, start: { x: -50, y: 340 } });
    expect(save).not.toHaveBeenCalled();
    expect(layoutsEqual(first, second)).toBe(false);
  });

  it('serializes writes and coalesces moves without letting an old response reset the drawing', async () => {
    const a = deferred();
    const b = deferred();
    const save = vi
      .fn<(layout: FlowLayout) => Promise<FlowLayout>>()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const store = createLayoutStore({}, save);
    store.setLayout(first);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    store.setLayout(second);
    store.setLayout(third);
    expect(save).toHaveBeenCalledTimes(1);
    a.resolve(first);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls.map(([layout]) => layout)).toEqual([first, third]);
    expect(store.getSnapshot()).toMatchObject({ layout: third, savedLayout: first, saving: true });
    b.resolve(third);
    await vi.waitFor(() => expect(hasUnsavedLayout(store.getSnapshot())).toBe(false));
    expect(store.getSnapshot().savedLayout).toEqual(third);
  });

  it('persists undo while a previous move is still being saved', async () => {
    const pending = deferred();
    const save = vi
      .fn<(layout: FlowLayout) => Promise<FlowLayout>>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (layout) => layout);
    const store = createLayoutStore(first, save);
    store.setLayout(second);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    store.setLayout(first);
    pending.resolve(second);
    await vi.waitFor(() => expect(hasUnsavedLayout(store.getSnapshot())).toBe(false));
    expect(save.mock.calls.map(([layout]) => layout)).toEqual([second, first]);
    expect(store.getSnapshot().layout).toEqual(first);
  });

  it('keeps failed work visible and retries with the latest coordinates', async () => {
    const save = vi
      .fn<(layout: FlowLayout) => Promise<FlowLayout>>()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementation(async (layout) => layout);
    const store = createLayoutStore(first, save);
    store.setLayout(second);
    await vi.waitFor(() => expect(store.getSnapshot().error).toBe('Offline'));
    expect(store.getSnapshot()).toMatchObject({ layout: second, savedLayout: first });
    expect(hasUnsavedLayout(store.getSnapshot())).toBe(true);
    store.refresh(third);
    expect(store.getSnapshot().layout).toEqual(second);
    store.retry();
    await vi.waitFor(() => expect(hasUnsavedLayout(store.getSnapshot())).toBe(false));
    expect(store.getSnapshot().savedLayout).toEqual(second);
  });

  it('writes an undo after a failed response even when it equals the last acknowledged layout', async () => {
    const save = vi
      .fn<(layout: FlowLayout) => Promise<FlowLayout>>()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockImplementation(async (layout) => layout);
    const store = createLayoutStore(first, save);
    store.setLayout(second);
    await vi.waitFor(() => expect(store.getSnapshot().error).toBe('Response lost'));
    store.setLayout(first);
    await vi.waitFor(() => expect(hasUnsavedLayout(store.getSnapshot())).toBe(false));
    expect(save.mock.calls.map(([layout]) => layout)).toEqual([second, first]);
  });

  it('notifies subscribers, keeps saving across unmount, and refreshes only settled layouts', async () => {
    const pending = deferred();
    const store = createLayoutStore(first, async () => pending.promise);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setLayout(second);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const notified = listener.mock.calls.length;
    pending.resolve(second);
    await vi.waitFor(() => expect(hasUnsavedLayout(store.getSnapshot())).toBe(false));
    expect(listener).toHaveBeenCalledTimes(notified);
    store.refresh(third);
    expect(store.getSnapshot().layout).toEqual(third);
  });

  it('writes only the layout endpoint, never a draft or publication', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ layout: second })));
    const client = createApiClient({ fetchImpl });
    expect(await saveFlowLayout(client, 'flow-1', second)).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/flows/flow-1/layout',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        body: JSON.stringify({ layout: second }),
      }),
    );
  });
});
