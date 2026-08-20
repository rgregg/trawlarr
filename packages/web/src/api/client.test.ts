import { describe, expect, it } from 'vitest';
import { ApiClientError, createApiClient, eventsUrl } from './client.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const fetchStub = (reply: { status: number; body: unknown }, calls: Call[] = []): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => await Promise.resolve(reply.body),
    } as Response;
  }) as unknown as typeof fetch;

const headersOf = (call: Call): Record<string, string> =>
  call.init!.headers as Record<string, string>;

describe('createApiClient', () => {
  it('sends the API key as a header, never as a query parameter', async () => {
    const calls: Call[] = [];
    const client = createApiClient({
      apiKey: 'secret-key-1234567890',
      fetchImpl: fetchStub({ status: 200, body: [{ id: 'lib-1' }] }, calls),
    });

    await client.get('/libraries');

    expect(calls[0]!.url).toBe('/api/v1/libraries');
    expect(calls[0]!.url).not.toContain('secret-key');
    expect(headersOf(calls[0]!)['X-Api-Key']).toBe('secret-key-1234567890');
  });

  it('sends no cookie and asks the browser to send none', async () => {
    const calls: Call[] = [];
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 200, body: [] }, calls),
    });

    await client.get('/libraries');

    // The whole security argument for the event socket is that there is NO
    // AMBIENT AUTHORITY here. A `cookie` header, or a `credentials` mode
    // that opted into sending one, would silently invalidate it.
    expect(Object.keys(headersOf(calls[0]!)).map((name) => name.toLowerCase())).not.toContain(
      'cookie',
    );
    expect(calls[0]!.init!.credentials).toBeUndefined();
  });

  it('returns the parsed body a GET answered with', async () => {
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 200, body: [{ id: 'lib-1', name: 'Movies' }] }),
    });

    await expect(client.get('/libraries')).resolves.toEqual([{ id: 'lib-1', name: 'Movies' }]);
  });

  it('sends a JSON body with a JSON content type, and neither on a bodyless POST', async () => {
    const withBody: Call[] = [];
    const withoutBody: Call[] = [];
    await createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 200, body: {} }, withBody),
    }).post('/libraries', { name: 'Movies', roots: ['/media'] });
    await createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 200, body: {} }, withoutBody),
    }).post('/libraries/lib-1/scan');

    expect(withBody[0]!.init!.method).toBe('POST');
    expect(withBody[0]!.init!.body).toBe('{"name":"Movies","roots":["/media"]}');
    expect(headersOf(withBody[0]!)['content-type']).toBe('application/json');
    expect(withoutBody[0]!.init!.body).toBeUndefined();
    expect(headersOf(withoutBody[0]!)['content-type']).toBeUndefined();
  });

  it('uses the verb each endpoint documents rather than tunnelling everything through POST', async () => {
    const calls: Call[] = [];
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 200, body: {} }, calls),
    });

    await client.patch('/flows/flow-1', { name: 'edited' });
    await client.put('/system/settings', { workers: 2 });

    expect(calls.map((call) => call.init!.method)).toEqual(['PATCH', 'PUT']);
  });

  it('turns the API error envelope into a typed error', async () => {
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({
        status: 409,
        body: { error: { code: 'flow-invalid', message: 'its flow still cannot be run.' } },
      }),
    });

    await expect(client.post('/libraries/lib-1/resume')).rejects.toMatchObject({
      status: 409,
      code: 'flow-invalid',
      // The daemon's messages are written FOR a reader; the UI shows them
      // verbatim rather than substituting a generic one.
      message: 'its flow still cannot be run.',
    });
    await expect(client.post('/libraries/lib-1/resume')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('survives a non-JSON error body from a proxy in front of the daemon', async () => {
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            await Promise.resolve();
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });

    await expect(client.get('/libraries')).rejects.toMatchObject({
      status: 502,
      code: 'unknown',
      message: 'The daemon answered 502.',
    });
  });

  it('reports a 401 as an unauthorised code the UI can branch on', async () => {
    const client = createApiClient({
      apiKey: 'wrong-key-000000000',
      fetchImpl: fetchStub({
        status: 401,
        body: { error: { code: 'unauthorized', message: 'no' } },
      }),
    });
    await expect(client.get('/libraries')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('returns nothing for a 204', async () => {
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 204, body: null }),
    });
    await expect(client.del('/flows/flow-1')).resolves.toBeUndefined();
  });

  it('prefixes a baseUrl so a dev server and the served bundle share one code path', async () => {
    const calls: Call[] = [];
    await createApiClient({
      baseUrl: 'http://127.0.0.1:8265',
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 200, body: [] }, calls),
    }).get('/libraries');

    expect(calls[0]!.url).toBe('http://127.0.0.1:8265/api/v1/libraries');
  });
});

describe('eventsUrl', () => {
  it('puts the key in the query string, because a browser cannot set upgrade headers', () => {
    const url = new URL(eventsUrl({ baseUrl: 'http://host:8265', apiKey: 'abc' }));
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/api/v1/events');
    expect(url.searchParams.get('apiKey')).toBe('abc');
  });

  it('uses wss when the page is served over https', () => {
    expect(eventsUrl({ baseUrl: 'https://host', apiKey: 'abc' })).toMatch(/^wss:/);
  });

  it('keeps the port, because the bundle is served same-origin by the daemon', () => {
    expect(
      new URL(eventsUrl({ baseUrl: 'http://host:8265/libraries/abc', apiKey: 'k' })).host,
    ).toBe('host:8265');
  });

  it('escapes a key that would otherwise change the query string it lands in', () => {
    const url = new URL(eventsUrl({ baseUrl: 'http://host', apiKey: 'a&b=c d' }));
    expect(url.searchParams.get('apiKey')).toBe('a&b=c d');
    expect(url.search).toBe('?apiKey=a%26b%3Dc%20d');
  });

  it('says what to do when there is no page and no baseUrl, rather than reading undefined', () => {
    expect(() => eventsUrl({ apiKey: 'abc' })).toThrow(/baseUrl/);
  });
});
