import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_COLLECTIONS, createCrudTransDbn, type DocumentPort } from './crud-trans-dbn.js';

const NOW = 1_700_000_000_000;

const makeDocuments = (): DocumentPort & { store: Map<string, Record<string, unknown>> } => {
  const store = new Map<string, Record<string, unknown>>();
  const key = (c: string, d: string) => `${c}::${d}`;
  return {
    store,
    get: (c, d) => store.get(key(c, d)),
    insert: (c, d, data) => void store.set(key(c, d), data),
    update: (c, d, patch) =>
      void store.set(key(c, d), { ...(store.get(key(c, d)) ?? {}), ...patch }),
    removeOne: (c, d) => void store.delete(key(c, d)),
  };
};

let documents: ReturnType<typeof makeDocuments>;
let setPauseAllNodes: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn>;
let crud: ReturnType<typeof createCrudTransDbn>;
let paused = false;

beforeEach(() => {
  documents = makeDocuments();
  paused = false;
  setPauseAllNodes = vi.fn((value: boolean) => {
    paused = value;
  });
  log = vi.fn();
  crud = createCrudTransDbn({
    documents,
    hostSettings: { setPauseAllNodes, getPauseAllNodes: () => paused },
    log,
    nowMs: () => NOW,
  });
});

describe('plugin-owned collections', () => {
  it('returns undefined for an unknown document, as processedCheck expects', async () => {
    await expect(
      crud('F2FOutputJSONDB', 'getById', '/media/movie.mkv', {}),
    ).resolves.toBeUndefined();
  });

  it('round-trips the processedAdd then processedCheck sequence', async () => {
    // This is the exact pattern the community plugins use.
    await crud('F2FOutputJSONDB', 'removeOne', '/media/movie.mkv', {});
    await crud('F2FOutputJSONDB', 'insert', '/media/movie.mkv', {
      _id: '/media/movie.mkv',
      DB: 'lib-movies',
    });
    await expect(crud('F2FOutputJSONDB', 'getById', '/media/movie.mkv', {})).resolves.toEqual({
      _id: '/media/movie.mkv',
      DB: 'lib-movies',
    });
  });

  it('merges on update', async () => {
    await crud('MyDB', 'insert', 'k', { a: 1, b: 2 });
    await crud('MyDB', 'update', 'k', { b: 3 });
    await expect(crud('MyDB', 'getById', 'k', {})).resolves.toEqual({ a: 1, b: 3 });
  });

  it('accepts collections nobody predicted', async () => {
    await crud('SomeoneElsesDB', 'insert', 'k', { v: 1 });
    await expect(crud('SomeoneElsesDB', 'getById', 'k', {})).resolves.toEqual({ v: 1 });
  });

  it('rejects an unknown mode loudly rather than silently doing nothing', async () => {
    await expect(crud('MyDB', 'frobnicate' as never, 'k', {})).rejects.toThrow(
      /unsupported crudTransDBN mode/i,
    );
  });
});

describe('host collections', () => {
  it('recognises the global settings collection', () => {
    expect(HOST_COLLECTIONS.has('SettingsGlobalJSONDB')).toBe(true);
  });

  it('really pauses the workers when a plugin asks', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { pauseAllNodes: true });
    expect(setPauseAllNodes).toHaveBeenCalledWith(true);
  });

  it('unpauses too', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { pauseAllNodes: false });
    expect(setPauseAllNodes).toHaveBeenCalledWith(false);
  });

  it('warns and ignores host settings keys it does not map', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { someFutureSetting: 1 });
    expect(setPauseAllNodes).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/someFutureSetting/));
  });

  it('does not write host collections into plugin document storage', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { pauseAllNodes: true });
    expect(documents.store.size).toBe(0);
  });

  it('reads back the host settings it understands', async () => {
    const value = await crud('SettingsGlobalJSONDB', 'getById', 'globalsettings', {});
    expect(value).toMatchObject({ pauseAllNodes: expect.any(Boolean) });
  });
});
