import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliverer, type Deliverer } from './deliver.js';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

const servers: Server[] = [];
const sockets = new Set<Socket>();
const deliverers: Deliverer[] = [];

const receiver = async (
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen, count: number) => void,
): Promise<{ origin: string; seen: Seen[] }> => {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(req, res, entry, seen.length);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
};

const make = (opts: Parameters<typeof createDeliverer>[0]): Deliverer => {
  const d = createDeliverer(opts);
  deliverers.push(d);
  return d;
};

const until = async (check: () => boolean, limitMs = 2000): Promise<void> => {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > limitMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of deliverers.splice(0)) d.stop();
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const hang = (): void => undefined;

describe('createDeliverer', () => {
  it('posts the JSON body with the destination headers', async () => {
    const { origin, seen } = await receiver((_req, res) => res.writeHead(200).end());
    const d = make({ log: () => undefined });
    d.enqueue(
      { name: 'ntfy', url: `${origin}/hook`, headers: [{ name: 'X-Auth', value: 'abc' }] },
      { hello: 'world' },
    );
    await d.drain(1000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.headers['x-auth']).toBe('abc');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ hello: 'world' });
    expect(d.lastResult('ntfy')?.ok).toBe(true);
    expect(d.lastResult('ntfy')?.status).toBe(200);
  });

  // The body is always JSON. A header object holding both "content-type" and "Content-Type"
  // is combined by fetch into "text/plain, application/json", which receivers reject.
  it('drops a destination content-type header in any case, keeping the built-in one', async () => {
    const { origin, seen } = await receiver((_req, res) => res.writeHead(200).end());
    const d = make({ log: () => undefined });
    d.enqueue(
      {
        name: 'ct',
        url: origin,
        headers: [
          { name: 'content-type', value: 'text/plain' },
          { name: 'CONTENT-TYPE', value: 'text/html' },
          { name: 'X-Auth', value: 'abc' },
        ],
      },
      {},
    );
    await d.drain(1000);
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.headers['x-auth']).toBe('abc');
  });

  it('returns from enqueue immediately and aborts an attempt past the timeout', async () => {
    const { origin } = await receiver(hang);
    const d = make({ timeoutMs: 50, retries: 1, backoffMs: [1], log: () => undefined });
    const before = performance.now();
    d.enqueue({ name: 'slow', url: origin, headers: [] }, {});
    expect(performance.now() - before).toBeLessThan(20);
    await until(() => d.lastResult('slow') !== undefined);
    expect(d.lastResult('slow')?.ok).toBe(false);
  });

  it('retries a 500 and ends ok on the following 200', async () => {
    const { origin, seen } = await receiver((_req, res, _s, count) =>
      res.writeHead(count === 1 ? 500 : 200).end(),
    );
    const d = make({ backoffMs: [1, 1, 1], log: () => undefined });
    d.enqueue({ name: 'flaky', url: origin, headers: [] }, {});
    await until(() => d.lastResult('flaky') !== undefined);
    expect(seen).toHaveLength(2);
    expect(d.lastResult('flaky')?.ok).toBe(true);
  });

  it('bounds drain against a receiver that never answers', async () => {
    const { origin } = await receiver(hang);
    const d = make({ log: () => undefined });
    d.enqueue({ name: 'hung', url: origin, headers: [] }, {});
    const start = performance.now();
    const { dropped } = await d.drain(100);
    expect(performance.now() - start).toBeLessThan(150 + 100);
    expect(dropped).toBeGreaterThanOrEqual(1);
  });

  it('drops the oldest entries past maxQueue and reports them from drain', async () => {
    const { origin, seen } = await receiver(hang);
    const d = make({ maxQueue: 3, log: () => undefined });
    for (let i = 0; i < 8; i++) {
      d.enqueue({ name: 'q', url: origin, headers: [] }, { n: i });
    }
    await until(() => seen.length >= 1);
    // The oldest five were evicted before the pump ever started, so the first
    // request on the wire is the sixth enqueued.
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ n: 5 });
    const { dropped } = await d.drain(50);
    expect(dropped).toBeGreaterThanOrEqual(5);
  });

  it('names the target and never the URL when an attempt fails', async () => {
    const { origin } = await receiver((_req, res) => res.writeHead(503).end());
    const lines: string[] = [];
    const d = make({ retries: 0, log: (line) => lines.push(line) });
    d.enqueue(
      { name: 'pager', url: `${origin}/x?token=SECRET`, headers: [{ name: 'A', value: 'HDRVAL' }] },
      {},
    );
    await until(() => d.lastResult('pager') !== undefined);
    const text = lines.join('\n');
    expect(text).toContain('pager');
    expect(text).toContain('503');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('HDRVAL');
    expect(text).not.toContain(origin);
  });

  it('does not log a fetch error message that embeds the URL', async () => {
    const lines: string[] = [];
    const d = make({ retries: 0, log: (line) => lines.push(line) });
    // Port 1 refuses; any message from fetch may carry the host.
    const result = await d.sendNow(
      { name: 'dead', url: 'http://127.0.0.1:1/p?token=SECRET', headers: [] },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('SECRET');
    expect(result.error).not.toContain('127.0.0.1');
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(lines.join('\n')).not.toContain('127.0.0.1');
  });

  it('does not follow a redirect to another origin with the destination headers', async () => {
    const other = await receiver((_req, res) => res.writeHead(200).end());
    const first = await receiver((_req, res) =>
      res.writeHead(302, { location: `${other.origin}/steal` }).end(),
    );
    const d = make({ retries: 0, log: () => undefined });
    const result = await d.sendNow(
      { name: 'redir', url: first.origin, headers: [{ name: 'X-Auth', value: 'abc' }] },
      {},
    );
    expect(result.ok).toBe(false);
    expect(other.seen).toHaveLength(0);
  });

  it('sendNow returns the result without going through the queue', async () => {
    const { origin } = await receiver((_req, res) => res.writeHead(204).end());
    const d = make({ log: () => undefined });
    const result = await d.sendNow({ name: 't', url: origin, headers: [] }, {});
    expect(result).toMatchObject({ ok: true, status: 204, error: null });
    expect(d.lastResult('t')).toEqual(result);
  });

  it('sends nothing after stop', async () => {
    const { origin, seen } = await receiver((_req, res) => res.writeHead(200).end());
    const d = make({ log: () => undefined });
    d.stop();
    d.enqueue({ name: 's', url: origin, headers: [] }, {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(0);
  });

  it('delivers a healthy destination promptly while another hangs', async () => {
    const hung = await receiver(hang);
    const ok = await receiver((_req, res) => res.writeHead(200).end());
    const d = make({ log: () => undefined });
    d.enqueue({ name: 'A', url: hung.origin, headers: [] }, {});
    await until(() => hung.seen.length >= 1);
    const start = performance.now();
    d.enqueue({ name: 'B', url: ok.origin, headers: [] }, {});
    await until(() => ok.seen.length >= 1, 500);
    expect(performance.now() - start).toBeLessThan(500);
    expect(d.lastResult('A')).toBeUndefined();
  });

  it('keeps the queue cap per destination', async () => {
    const hung = await receiver(hang);
    const ok = await receiver((_req, res) => res.writeHead(200).end());
    const d = make({ maxQueue: 2, log: () => undefined });
    d.enqueue({ name: 'B', url: ok.origin, headers: [] }, { n: 'b1' });
    d.enqueue({ name: 'B', url: ok.origin, headers: [] }, { n: 'b2' });
    for (let i = 0; i < 6; i++) d.enqueue({ name: 'A', url: hung.origin, headers: [] }, { i });
    await until(() => ok.seen.length >= 2);
    expect(ok.seen.map((s) => JSON.parse(s.body))).toEqual([{ n: 'b1' }, { n: 'b2' }]);
    const { dropped } = await d.drain(50);
    // 4 evicted from A, then A's remaining queue and in-flight request.
    expect(dropped).toBeGreaterThanOrEqual(4);
  });

  it('bounds drain across two hung destinations and sums their drops', async () => {
    const one = await receiver(hang);
    const two = await receiver(hang);
    const d = make({ log: () => undefined });
    for (let i = 0; i < 2; i++) {
      d.enqueue({ name: 'A', url: one.origin, headers: [] }, {});
      d.enqueue({ name: 'B', url: two.origin, headers: [] }, {});
    }
    await until(() => one.seen.length >= 1 && two.seen.length >= 1);
    const start = performance.now();
    const { dropped } = await d.drain(100);
    expect(performance.now() - start).toBeLessThan(250);
    expect(dropped).toBe(4);
  });

  it('aborts an in-flight sendNow when drain hits its deadline', async () => {
    const hung = await receiver(hang);
    const d = make({ log: () => undefined });
    const sent = d.sendNow({ name: 'T', url: hung.origin, headers: [] }, {});
    await until(() => hung.seen.length >= 1);
    const start = performance.now();
    await d.drain(50);
    const result = await sent;
    expect(performance.now() - start).toBeLessThan(250);
    expect(result).toMatchObject({ ok: false, error: 'aborted' });
  });

  it('lets stop abort a sendNow that starts right after a drain', async () => {
    const hung = await receiver(hang);
    const d = make({ log: () => undefined });
    d.enqueue({ name: 'A', url: hung.origin, headers: [] }, {});
    await until(() => hung.seen.length >= 1);
    await d.drain(30);
    const sent = d.sendNow({ name: 'T', url: hung.origin, headers: [] }, {});
    await until(() => hung.seen.length >= 2);
    const start = performance.now();
    d.stop();
    const result = await sent;
    expect(performance.now() - start).toBeLessThan(250);
    expect(result.error).toBe('aborted');
  });

  // Runs `hook` synchronously inside drain's deadline abort: the attempt's
  // signal fires from within epoch.abort(), before drain has settled or swapped.
  const onDrainAbort = (hook: () => void): void => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      init?.signal?.addEventListener('abort', hook, { once: true });
      return real(input, init);
    });
  };

  it('ends a sendNow started inside the drain wait as aborted, not a full attempt', async () => {
    const hung = await receiver(hang);
    const d = make({ log: () => undefined });
    let late: Promise<{ error: string | null }> | undefined;
    onDrainAbort(() => {
      late ??= d.sendNow({ name: 'T', url: hung.origin, headers: [] }, {});
    });
    d.enqueue({ name: 'A', url: hung.origin, headers: [] }, {});
    await until(() => hung.seen.length >= 1);
    const start = performance.now();
    await d.drain(30);
    const result = await Promise.race([
      late ?? Promise.reject(new Error('hook never ran')),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('outlived drain')), 500)),
    ]);
    expect(performance.now() - start).toBeLessThan(400);
    expect(result.error).toBe('aborted');
    expect(hung.seen).toHaveLength(1);
  });

  it('sends nothing for work enqueued inside the drain wait and still meets the deadline', async () => {
    const hung = await receiver(hang);
    const ok = await receiver((_req, res) => res.writeHead(200).end());
    const d = make({ log: () => undefined });
    onDrainAbort(() => {
      d.enqueue({ name: 'A', url: ok.origin, headers: [] }, {});
      d.enqueue({ name: 'C', url: ok.origin, headers: [] }, {});
    });
    d.enqueue({ name: 'A', url: hung.origin, headers: [] }, {});
    await until(() => hung.seen.length >= 1);
    const start = performance.now();
    await d.drain(50);
    expect(performance.now() - start).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ok.seen).toHaveLength(0);
  });
});
