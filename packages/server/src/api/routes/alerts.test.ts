import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAlertService } from '../../alerts/alert-service.js';
import { createDeliverer } from '../../alerts/deliver.js';
import { openDatabase, type Db } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createEventBus } from '../../daemon/events.js';
import type { ScanCoordinator } from '../../daemon/scan-coordinator.js';
import type { Supervisor } from '../../daemon/supervisor.js';
import { createFlowRepo } from '../../db/flow-repo.js';
import { createSettingsRepo, newDestination, type SettingsRepo } from '../../db/settings-repo.js';
import { createApiContext, createApiServer } from '../server.js';

const API_KEY = 'the-fixed-test-api-key-000000';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'trawlarr-alerts-route-'));
const MASK = '••••';
const TOKEN = 'tok-9f8e7d6c5b4a';

const fakeSupervisor = {} as Supervisor;
const fakeScans = {
  request: () => {},
  syncWatchers: () => {},
  idle: async () => {
    await Promise.resolve();
  },
  start: () => {},
  stop: async () => {
    await Promise.resolve();
  },
  scanning: () => [],
} as ScanCoordinator;

let db: Db;
let settings: SettingsRepo;
let server: Server;
let baseUrl: string;
let receiver: Server;
let receiverUrl: string;
let receiverStatus = 200;
let received: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
let logged: string[] = [];

const listen = async (s: Server): Promise<string> => {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
};

beforeEach(async () => {
  received = [];
  logged = [];
  receiverStatus = 200;
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = receiverStatus;
      res.end('ok');
    });
  });
  receiverUrl = await listen(receiver);

  db = openDatabase({ file: ':memory:' });
  migrate(db);
  settings = createSettingsRepo({ db, generateApiKey: () => API_KEY });
  const deliverer = createDeliverer({ retries: 0, log: (l) => logged.push(l) });
  const service = createAlertService({
    settings,
    deliverer,
    extraSecrets: () => [],
    nowMs: () => 1_000,
    log: (l) => logged.push(l),
  });
  const ctx = createApiContext({
    db,
    settings,
    bus: createEventBus(),
    supervisor: fakeSupervisor,
    scans: fakeScans,
    dataDir: DATA_DIR,
    nowMs: () => 1_000,
    version: '0.0.0-test',
    alerts: { sendTest: (name) => service.sendTest(name), lastResult: deliverer.lastResult },
  });
  server = createApiServer(ctx, { onError: () => {} });
  baseUrl = await listen(server);
});

afterEach(async () => {
  for (const s of [server, receiver]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  db.close();
});

interface Result {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper over arbitrary JSON
  body: any;
}

const api = async (
  method: string,
  path: string,
  options: { body?: unknown; apiKey?: string | null } = {},
): Promise<Result> => {
  const key = options.apiKey === undefined ? API_KEY : options.apiKey;
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(key === null ? {} : { 'x-api-key': key }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text === '' ? undefined : JSON.parse(text) };
};

const seed = (): void => {
  settings.setAlerts({
    publicBaseUrl: 'https://trawlarr.lan',
    destinations: [
      {
        ...newDestination('ha', `${receiverUrl}/hook/${TOKEN}?k=1`),
        headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
      },
    ],
  });
};

describe('GET /alerts', () => {
  it('masks the url and header values, never returning either in full', async () => {
    seed();
    const res = await api('GET', '/alerts');

    expect(res.status).toBe(200);
    expect(res.body.publicBaseUrl).toBe('https://trawlarr.lan');
    expect(res.body.destinations).toHaveLength(1);
    const d = res.body.destinations[0];
    expect(d.name).toBe('ha');
    expect(d.enabled).toBe(true);
    expect(d.url).toBe(`${receiverUrl}/${MASK}`);
    expect(d.headers).toEqual([{ name: 'Authorization', value: MASK }]);
    expect(d.events['file.failed']).toBe(true);
    expect(res.text).not.toContain(TOKEN);
  });

  it('reports a last delivery result once one exists', async () => {
    seed();
    expect((await api('GET', '/alerts')).body.destinations[0].lastResult).toBeUndefined();
    await api('POST', '/alerts/ha/test');
    expect((await api('GET', '/alerts')).body.destinations[0].lastResult).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it('answers a corrupt stored section with a 500 that names no value', async () => {
    db.prepare(`INSERT OR REPLACE INTO setting (key, value) VALUES ('alerts.destinations', ?)`).run(
      JSON.stringify([{ name: 5, url: `https://x/${TOKEN}` }]),
    );
    const res = await api('GET', '/alerts');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(TOKEN);
  });
});

describe('PUT /alerts', () => {
  it('keeps the stored url and header value when the masked ones come back', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].enabled = false;
    got.destinations[0].events['file.failed'] = false;

    const res = await api('PUT', '/alerts', { body: got });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(TOKEN);
    const stored = settings.getAlerts().destinations[0]!;
    expect(stored.url).toBe(`${receiverUrl}/hook/${TOKEN}?k=1`);
    expect(stored.headers).toEqual([{ name: 'Authorization', value: `Bearer ${TOKEN}` }]);
    expect(stored.enabled).toBe(false);
    expect(stored.events['file.failed']).toBe(false);
  });

  it('refuses a masked header when the url changed, so the stored secret cannot be sent elsewhere', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].url = 'https://attacker.example/x';

    const res = await api('PUT', '/alerts', { body: got });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain(TOKEN);
    const stored = settings.getAlerts().destinations[0]!;
    expect(stored.url).toBe(`${receiverUrl}/hook/${TOKEN}?k=1`);
    expect(stored.headers[0]!.value).toBe(`Bearer ${TOKEN}`);
  });

  it('accepts a new url with a freshly typed header value', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].url = 'https://other.example/x';
    got.destinations[0].headers = [{ name: 'Authorization', value: 'Bearer typed' }];

    expect((await api('PUT', '/alerts', { body: got })).status).toBe(200);
    expect(settings.getAlerts().destinations[0]!.headers[0]!.value).toBe('Bearer typed');
  });

  it('round-trips same-named headers masked, each keeping its own value', async () => {
    settings.setAlerts({
      publicBaseUrl: '',
      destinations: [
        {
          ...newDestination('ha', `${receiverUrl}/h`),
          headers: [
            { name: 'X', value: 'first' },
            { name: 'X', value: 'second' },
          ],
        },
      ],
    });
    const got = (await api('GET', '/alerts')).body;
    expect(got.destinations[0].headers).toHaveLength(2);

    expect((await api('PUT', '/alerts', { body: got })).status).toBe(200);
    expect(settings.getAlerts().destinations[0]!.headers.map((h) => h.value)).toEqual([
      'first',
      'second',
    ]);

    got.destinations[0].headers.push({ name: 'X', value: MASK });
    const res = await api('PUT', '/alerts', { body: got });
    expect(res.status).toBe(400);
    expect(settings.getAlerts().destinations[0]!.headers).toHaveLength(2);
  });

  it('replaces a value that is not the mask', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].url = 'https://new.example/hook/zzz';
    got.destinations[0].headers = [{ name: 'Authorization', value: 'Bearer fresh' }];

    expect((await api('PUT', '/alerts', { body: got })).status).toBe(200);

    const stored = settings.getAlerts().destinations[0]!;
    expect(stored.url).toBe('https://new.example/hook/zzz');
    expect(stored.headers[0]!.value).toBe('Bearer fresh');
  });

  it('refuses a masked url on a renamed destination, asking for it again', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].name = 'renamed';

    const res = await api('PUT', '/alerts', { body: got });

    expect(res.status).toBe(400);
    expect(res.text).toContain('re-enter');
    expect(res.text).not.toContain(TOKEN);
    expect(settings.getAlerts().destinations[0]!.name).toBe('ha');
  });

  it('refuses a masked header value with no stored header of that name', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].headers.push({ name: 'X-New', value: MASK });

    const res = await api('PUT', '/alerts', { body: got });

    expect(res.status).toBe(400);
    expect(res.text).toContain('X-New');
  });

  it('rejects a bad url with a 400 that does not echo it', async () => {
    seed();
    const got = (await api('GET', '/alerts')).body;
    got.destinations[0].url = `ftp://secret.example/${TOKEN}`;

    const res = await api('PUT', '/alerts', { body: got });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain(TOKEN);
    expect(settings.getAlerts().destinations[0]!.url).toContain(receiverUrl);
  });

  it('accepts a new destination with a full url, and can repair a corrupt section', async () => {
    db.prepare(`INSERT OR REPLACE INTO setting (key, value) VALUES ('alerts.destinations', ?)`).run(
      JSON.stringify('garbage'),
    );
    const res = await api('PUT', '/alerts', {
      body: { publicBaseUrl: '', destinations: [newDestination('n', 'https://h.example/a')] },
    });
    expect(res.status).toBe(200);
    expect(settings.getAlerts().destinations.map((d) => d.name)).toEqual(['n']);
  });
});

describe('POST /alerts/:name/test', () => {
  it('sends to the real receiver, with the stored header, and reports its status', async () => {
    seed();
    receiverStatus = 204;

    const res = await api('POST', '/alerts/ha/test');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 204 });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(received[0]!.body).event).toBe('test');
    expect(res.text).not.toContain(TOKEN);
  });

  it('reports a failing receiver as a result, not an error', async () => {
    seed();
    receiverStatus = 500;
    const res = await api('POST', '/alerts/ha/test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, status: 500 });
  });

  it('answers an unknown destination with 404', async () => {
    seed();
    expect((await api('POST', '/alerts/nope/test')).status).toBe(404);
  });
});

describe('auth', () => {
  it('requires the api key on every alert route, as /nodes does', async () => {
    seed();
    for (const [method, path] of [
      ['GET', '/alerts'],
      ['PUT', '/alerts'],
      ['POST', '/alerts/ha/test'],
    ] as const) {
      const res = await api(method, path, {
        apiKey: null,
        body: method === 'PUT' ? {} : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect((await api('GET', '/nodes', { apiKey: null })).status).toBe(401);
  });
});

describe('PUT /alerts — destinations a published flow uses', () => {
  const hookFlow = (destination: string) => ({
    nodes: [
      { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      {
        id: 'hook',
        pluginId: 'trawlarr:sendWebhook',
        pluginVersion: '1.0.0',
        inputs: { destination },
      },
    ],
    edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'hook' }],
  });
  const withDestinations = async (names: string[]) => {
    const current = (await api('GET', '/alerts')).body;
    const template = current.destinations[0];
    return {
      publicBaseUrl: current.publicBaseUrl,
      destinations: names.map((name) =>
        name === 'ha'
          ? { ...template, name }
          : { ...template, name, url: `${receiverUrl}/fresh`, headers: [] },
      ),
    };
  };

  it('refuses to remove a destination a published flow names, and stores nothing', async () => {
    seed();
    const flow = createFlowRepo(db).create({
      name: 'movies',
      definition: hookFlow('ha'),
      nowMs: 1,
    });
    const before = settings.getAlerts();
    const res = await api('PUT', '/alerts', { body: await withDestinations([]) });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('"ha"');
    expect(res.body.error.message).toContain('movies');
    expect(res.body.error.message).toContain(flow.id);
    expect(settings.getAlerts()).toEqual(before);
  });

  it('refuses a rename the same way', async () => {
    seed();
    createFlowRepo(db).create({ name: 'movies', definition: hookFlow('ha'), nowMs: 1 });
    const before = settings.getAlerts();
    const res = await api('PUT', '/alerts', { body: await withDestinations(['ha2']) });
    expect(res.status).toBe(409);
    expect(settings.getAlerts()).toEqual(before);
  });

  it('allows removing a destination no published flow names, and keeping or adding others', async () => {
    seed();
    createFlowRepo(db).create({ name: 'movies', definition: hookFlow('other'), nowMs: 1 });
    expect(
      (await api('PUT', '/alerts', { body: await withDestinations(['ha', 'new']) })).status,
    ).toBe(200);
    expect((await api('PUT', '/alerts', { body: await withDestinations(['new']) })).status).toBe(
      200,
    );
  });

  it('allows saving a disabled destination that a published flow still names', async () => {
    seed();
    createFlowRepo(db).create({ name: 'movies', definition: hookFlow('ha'), nowMs: 1 });
    const body = await withDestinations(['ha']);
    body.destinations[0].enabled = false;
    expect((await api('PUT', '/alerts', { body })).status).toBe(200);
  });

  it('does not count a destination only a draft names', async () => {
    seed();
    const flow = createFlowRepo(db).create({
      name: 'movies',
      definition: hookFlow('other'),
      nowMs: 1,
    });
    createFlowRepo(db).saveDraft({
      id: flow.id,
      draft: hookFlow('ha'),
      baseHash: flow.definitionHash,
      nowMs: 2,
    });
    expect((await api('PUT', '/alerts', { body: await withDestinations([]) })).status).toBe(200);
  });
});
