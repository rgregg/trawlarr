import { describe, expect, it } from 'vitest';
import { createKeyStore, type KeyStorage } from './key.js';

const memoryStorage = (): KeyStorage & { entries: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    entries: map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe('createKeyStore', () => {
  it('round-trips a key', () => {
    const store = createKeyStore(memoryStorage());
    expect(store.read()).toBeNull();
    store.write('secret-key-1234567890');
    expect(store.read()).toBe('secret-key-1234567890');
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('treats an empty stored value as absent', () => {
    const storage = memoryStorage();
    storage.setItem('trawlarr.apiKey', '');
    expect(createKeyStore(storage).read()).toBeNull();
  });

  it('stores under one documented name, so "Sign out" and devtools agree what to remove', () => {
    const storage = memoryStorage();
    createKeyStore(storage).write('secret-key-1234567890');

    expect([...storage.entries.keys()]).toEqual(['trawlarr.apiKey']);
  });

  it('really removes the entry on clear, rather than blanking it', () => {
    const storage = memoryStorage();
    const store = createKeyStore(storage);
    store.write('secret-key-1234567890');

    store.clear();

    // A blanked value still leaves the key on a shared browser's disk. The
    // only thing this store can offer against same-profile access is that
    // "Sign out" genuinely deletes it.
    expect(storage.entries.has('trawlarr.apiKey')).toBe(false);
  });
});
