import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { guardClient } from './auth-guard.js';

const okClient = (): ApiClient => ({
  get: async <T>() => await Promise.resolve('ok' as T),
  post: async <T>() => await Promise.resolve('ok' as T),
  patch: async <T>() => await Promise.resolve('ok' as T),
  put: async <T>() => await Promise.resolve('ok' as T),
  del: async () => {
    await Promise.resolve();
  },
});

const failingClient = (error: unknown): ApiClient => ({
  get: async <T>(): Promise<T> => {
    throw error;
  },
  post: async <T>(): Promise<T> => {
    throw error;
  },
  patch: async <T>(): Promise<T> => {
    throw error;
  },
  put: async <T>(): Promise<T> => {
    throw error;
  },
  del: async () => {
    throw error;
  },
});

describe('guardClient', () => {
  it('passes a successful call straight through, on every verb', async () => {
    const onUnauthorized = vi.fn();
    const client = guardClient(okClient(), onUnauthorized);

    await expect(client.get('/x')).resolves.toBe('ok');
    await expect(client.post('/x')).resolves.toBe('ok');
    await expect(client.patch('/x', {})).resolves.toBe('ok');
    await expect(client.put('/x', {})).resolves.toBe('ok');
    await expect(client.del('/x')).resolves.toBeUndefined();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('calls onUnauthorized and rethrows on a 401, so the caller still sees the error', async () => {
    const onUnauthorized = vi.fn();
    const error = new ApiClientError({ status: 401, code: 'unauthorized', message: 'no' });
    const client = guardClient(failingClient(error), onUnauthorized);

    await expect(client.get('/x')).rejects.toBe(error);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('leaves any other error alone, never treating it as a session failure', async () => {
    const onUnauthorized = vi.fn();
    const error = new ApiClientError({ status: 404, code: 'not-found', message: 'no' });
    const client = guardClient(failingClient(error), onUnauthorized);

    await expect(client.get('/x')).rejects.toBe(error);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('waits for an async onUnauthorized before letting the rejection propagate', async () => {
    const order: string[] = [];
    const onUnauthorized = async (): Promise<void> => {
      order.push('signing-out');
      await Promise.resolve();
      order.push('signed-out');
    };
    const error = new ApiClientError({ status: 401, code: 'unauthorized', message: 'no' });
    const client = guardClient(failingClient(error), onUnauthorized);

    await client.get('/x').catch(() => {
      order.push('caught');
    });

    expect(order).toEqual(['signing-out', 'signed-out', 'caught']);
  });

  it('does not call onUnauthorized for a non-ApiClientError rejection with no status', async () => {
    const onUnauthorized = vi.fn();
    const client = guardClient(failingClient(new Error('boom')), onUnauthorized);

    await expect(client.get('/x')).rejects.toThrow('boom');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
