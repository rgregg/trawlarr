/**
 * Component tests for the Nodes tab.
 *
 * Every case here is a defect this feature actually shipped and a browser
 * pass caught by hand. `nodes-model.test.ts` already covers the pure logic;
 * what it cannot cover is the part that broke — whether the RENDERED tab
 * re-fetches, re-renders and shows the right words — so these tests drive the
 * real component with a recording fake `ApiClient` (see
 * `src/test/fake-api-client.ts`) and assert on the DOM and on the request log.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { initialLiveState, type LiveState } from '../../api/events.js';
import { createFakeClient } from '../../test/fake-api-client.js';
import { Nodes } from './Nodes.js';
import type { NodeMutationResponse, NodeResource } from './nodes-model.js';

const live: LiveState = initialLiveState;

const remoteNode = (overrides: Partial<NodeResource> = {}): NodeResource => ({
  id: 'node-1',
  name: 'basement',
  local: false,
  online: true,
  revokedAt: null,
  enrolled: true,
  enrollExpiresAt: null,
  lastSeenAt: 1_760_000_000_000,
  buildVersion: '1.2.3',
  hardwareTypes: [],
  hardwareCaps: {},
  pathMap: [{ serverPath: '/media', nodePath: '/mnt/media' }],
  pathMapError: null,
  paused: false,
  schedule: { baseCounts: { transcode: 2, health: 1 } },
  libraries: [],
  running: [],
  ...overrides,
});

const localNode = (): NodeResource =>
  remoteNode({ id: 'local', name: 'This daemon', local: true, running: ['job-a'] });

/**
 * What `PUT /nodes/:id` and friends really answer: `NodeResource` MINUS
 * `local`/`online`/`running`. Built by DELETING those fields rather than by
 * omitting them from a literal, so this fixture cannot drift into accidentally
 * carrying them and making the tab look safe when it is not.
 */
const mutationResponse = (node: NodeResource): NodeMutationResponse => {
  const copy: Record<string, unknown> = { ...node };
  delete copy.local;
  delete copy.online;
  delete copy.running;
  return copy as unknown as NodeMutationResponse;
};

const renderNodes = (client: ReturnType<typeof createFakeClient>) =>
  render(<Nodes client={client} live={live} navigate={() => undefined} />);

/** The card `<li>` for a node, found by its heading. */
const cardFor = async (name: string): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name, level: 3 });
  const card = heading.closest('li');
  if (card === null) throw new Error(`No card for ${name}.`);
  return card;
};

/**
 * The path table's inputs, in document order: `[serverPath, nodePath]` per
 * row. Scoped to the table rather than to the card — the card's other
 * textboxes (the worker count) are interleaved with these in the card's own
 * `getAllByRole('textbox')` order, which is how an earlier version of this
 * file typed a path into the worker-count field and still passed.
 */
const pathInputs = (card: HTMLElement): HTMLInputElement[] =>
  within(within(card).getByRole('table')).getAllByRole('textbox') as HTMLInputElement[];

const openDetails = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const card = await cardFor(name);
  await user.click(within(card).getByRole('button', { name: 'Details' }));
  return card;
};

describe('Nodes tab', () => {
  it('shows a node the list reports, with its build and running count', async () => {
    const client = createFakeClient({
      'GET /nodes': [
        localNode(),
        remoteNode({ running: ['job-1', 'job-2'], buildVersion: 'abc1234' }),
      ],
      'GET /libraries': [],
      'GET /system/version': { commit: 'deadbeefcafe' },
    });
    renderNodes(client);

    const card = await cardFor('basement');
    expect(within(card).getByText('Online')).toBeInTheDocument();
    // The build was in the API response all along and the card never printed
    // it, so a node on a different build was indistinguishable from one on
    // the same build.
    expect(card).toHaveTextContent('Build abc1234.');
    expect(card).toHaveTextContent('2 running.');
  });

  it('re-fetches the list after Add node rather than rendering the create response', async () => {
    const user = userEvent.setup();
    const created = remoteNode({ id: 'node-2', name: 'attic', enrolled: false, online: false });
    let listed: NodeResource[] = [localNode()];
    const client = createFakeClient({
      'GET /nodes': () => listed,
      'GET /libraries': [],
      'GET /system/version': { commit: 'deadbeefcafe' },
      'POST /nodes': () => {
        listed = [localNode(), created];
        // The response has no `local`/`online`/`running`. Rendering it as a
        // row threw on `node.running.length` and took the whole tab down.
        return { node: mutationResponse(created), enrollToken: 'tok-1', enrollExpiresAt: 1 };
      },
    });
    renderNodes(client);
    await cardFor('This daemon');

    await user.click(screen.getByRole('button', { name: 'Add node' }));
    await user.type(screen.getByLabelText('Name'), 'attic');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // The dialog is what proves the create landed...
    await screen.findByRole('heading', { name: 'Add attic on the new machine' });
    // ...and the list request AFTER it is what proves the tab re-read the
    // truth instead of trusting the create's answer.
    const order = client.signatures();
    const create = order.indexOf('POST /nodes');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(order.slice(create + 1)).toContain('GET /nodes');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    const card = await cardFor('attic');
    expect(within(card).getByText('Waiting to join')).toBeInTheDocument();
  });

  it('re-fetches and re-renders after saving a worker count', async () => {
    const user = userEvent.setup();
    let listed = [localNode(), remoteNode()];
    const client = createFakeClient({
      'GET /nodes': () => listed,
      'GET /libraries': [],
      'GET /system/version': { commit: null },
      'PUT /nodes/node-1': (body) => {
        const schedule = (body as { schedule: NodeResource['schedule'] }).schedule;
        const next = remoteNode({ schedule });
        listed = [localNode(), next];
        return mutationResponse(next);
      },
    });
    renderNodes(client);
    const card = await openDetails(user, 'basement');

    const field = within(card).getByLabelText('Transcode workers');
    await user.clear(field);
    await user.type(field, '5');
    await user.click(within(card).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const order = client.signatures();
      const put = order.indexOf('PUT /nodes/node-1');
      expect(put).toBeGreaterThanOrEqual(0);
      expect(order.slice(put + 1)).toContain('GET /nodes');
    });
    // Still rendered: the crash this guards against unmounted the tab, so the
    // proof that it did not is that the card is still on screen afterwards.
    expect(await cardFor('basement')).toBeInTheDocument();
  });

  it('flips Paused exactly once per click and keeps the saved value', async () => {
    const user = userEvent.setup();
    let listed = [localNode(), remoteNode({ paused: false })];
    const client = createFakeClient({
      'GET /nodes': () => listed,
      'GET /libraries': [],
      'GET /system/version': { commit: null },
      'PUT /nodes/node-1': (body) => {
        const next = remoteNode({ paused: (body as { paused: boolean }).paused });
        listed = [localNode(), next];
        return mutationResponse(next);
      },
    });
    renderNodes(client);
    const card = await openDetails(user, 'basement');

    const checkbox = within(card).getByLabelText('Paused');
    expect(checkbox).not.toBeChecked();

    // Sample the box on every animation-frame-ish tick while the save is in
    // flight. The bug was a FLICKER: the click flipped it, React put it
    // straight back from the row (which had not reloaded yet), and the reload
    // flipped it a third time. A before/after assertion cannot see that.
    const seen: boolean[] = [(checkbox as HTMLInputElement).checked];
    const stop = setInterval(() => {
      const current = (checkbox as HTMLInputElement).checked;
      if (seen[seen.length - 1] !== current) seen.push(current);
    }, 1);
    await user.click(checkbox);
    await waitFor(() => {
      expect(client.signatures().filter((s) => s === 'GET /nodes').length).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(within(card).getByLabelText('Paused')).toBeChecked();
    });
    clearInterval(stop);

    // `seen` starts with the pre-click value, so one transition total.
    expect(seen).toEqual([false, true]);
  });

  it('saves paths and re-fetches the list', async () => {
    const user = userEvent.setup();
    let listed = [localNode(), remoteNode()];
    const client = createFakeClient({
      'GET /nodes': () => listed,
      'GET /libraries': [],
      'GET /system/version': { commit: null },
      'PUT /nodes/node-1': (body) => {
        const pathMap = (body as { pathMap: NodeResource['pathMap'] }).pathMap;
        const next = remoteNode({ pathMap });
        listed = [localNode(), next];
        return mutationResponse(next);
      },
    });
    renderNodes(client);
    const card = await openDetails(user, 'basement');

    const serverPath = pathInputs(card)[0] as HTMLInputElement;
    await user.clear(serverPath);
    await user.type(serverPath, '/library');
    await user.click(within(card).getByRole('button', { name: 'Save paths' }));

    await waitFor(() => {
      const order = client.signatures();
      const put = order.indexOf('PUT /nodes/node-1');
      expect(put).toBeGreaterThanOrEqual(0);
      expect(order.slice(put + 1)).toContain('GET /nodes');
    });
    const sent = client.calls.find((call) => call.method === 'PUT');
    expect(sent?.body).toEqual({ pathMap: [{ serverPath: '/library', nodePath: '/mnt/media' }] });
  });

  it('re-fetches after Revoke and renders the node as revoked', async () => {
    const user = userEvent.setup();
    let listed = [localNode(), remoteNode()];
    const client = createFakeClient({
      'GET /nodes': () => listed,
      'GET /libraries': [],
      'GET /system/version': { commit: null },
      'POST /nodes/node-1/revoke': () => {
        const next = remoteNode({ revokedAt: 1_760_000_100_000, online: false });
        listed = [localNode(), next];
        return mutationResponse(next);
      },
    });
    renderNodes(client);
    const card = await openDetails(user, 'basement');

    await user.click(within(card).getByRole('button', { name: 'Revoke' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, revoke' }));

    await waitFor(() => {
      const order = client.signatures();
      const revoke = order.indexOf('POST /nodes/node-1/revoke');
      expect(revoke).toBeGreaterThanOrEqual(0);
      expect(order.slice(revoke + 1)).toContain('GET /nodes');
    });
    const after = await cardFor('basement');
    await waitFor(() => {
      expect(within(after).getByText('Revoked')).toBeInTheDocument();
    });
  });

  describe('path-map validation happens before the request', () => {
    const cases: Array<{ name: string; rows: Array<[string, string]>; expect: RegExp }> = [
      {
        name: 'a relative path',
        rows: [['media', '/mnt/media']],
        expect: /must be an absolute path/,
      },
      {
        name: 'a node path listed twice',
        rows: [
          ['/a', '/x'],
          ['/b', '/x'],
        ],
        expect: /listed more than once/,
      },
      {
        // The rule that was NOT echoed client-side. The server refused it, and
        // its refusal rendered as a paragraph below Libraries/Hardware/Revoke
        // worded "is mapped more than once" — copy this screen must never show.
        name: 'a nested suffix that does not match',
        rows: [
          ['/a', '/x'],
          ['/a/tv', '/x/shows'],
        ],
        expect: /same place under/,
      },
    ];

    for (const testCase of cases) {
      it(`refuses ${testCase.name} without calling the daemon`, async () => {
        const user = userEvent.setup();
        const client = createFakeClient({
          'GET /nodes': [localNode(), remoteNode({ pathMap: [] })],
          'GET /libraries': [],
          'GET /system/version': { commit: null },
          // Deliberately NO `PUT /nodes/node-1`: the fake answers 404 for an
          // unrouted request, so a save that escapes validation fails loudly
          // rather than quietly succeeding.
        });
        renderNodes(client);
        const card = await openDetails(user, 'basement');

        for (const [serverPath, nodePath] of testCase.rows) {
          await user.click(within(card).getByRole('button', { name: 'Add row' }));
          const boxes = pathInputs(card);
          await user.type(boxes[boxes.length - 2] as HTMLInputElement, serverPath);
          await user.type(boxes[boxes.length - 1] as HTMLInputElement, nodePath);
        }
        await user.click(within(card).getByRole('button', { name: 'Save paths' }));

        expect(await within(card).findByText(testCase.expect)).toBeInTheDocument();
        expect(client.signatures()).not.toContain('PUT /nodes/node-1');
        expect(client.calls.every((call) => call.method === 'GET')).toBe(true);
      });
    }
  });

  it('makes a revoked node read-only and offers Delete', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({
      'GET /nodes': [localNode(), remoteNode({ revokedAt: 1_760_000_100_000, online: false })],
      'GET /libraries': [],
      'GET /system/version': { commit: null },
    });
    renderNodes(client);
    const card = await openDetails(user, 'basement');

    for (const box of within(card).getAllByRole('textbox')) {
      expect(box).toHaveAttribute('readonly');
    }
    expect(within(card).getByLabelText('Paused')).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Save paths' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Add row' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Revoke' })).toBeNull();
    // Delete is the only way out of a revoke, so it has to be offered.
    expect(within(card).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('prints a library a node cannot reach, in the node’s own words', async () => {
    const client = createFakeClient({
      'GET /nodes': [
        localNode(),
        remoteNode({
          libraries: [
            { libraryId: 'lib-1', reachable: false, detail: 'ENOENT: /mnt/media/tv' },
            { libraryId: 'lib-2', reachable: true, detail: '' },
          ],
        }),
      ],
      'GET /libraries': [
        { id: 'lib-1', name: 'TV' },
        { id: 'lib-2', name: 'Movies' },
      ],
      'GET /system/version': { commit: null },
    });
    renderNodes(client);

    const card = await cardFor('basement');
    await waitFor(() => {
      expect(card).toHaveTextContent('Unreachable: TV: ENOENT: /mnt/media/tv');
    });
    // The word this screen must never use. It came from the server's own
    // path-map refusal leaking into the card ("is mapped more than once"),
    // which is jargon for a state the operator cannot act on. Asserted over
    // the WHOLE tab's rendered text, not one element, because that is the
    // only form of the check that survives the copy moving.
    expect(document.body.textContent ?? '').not.toMatch(/mapped/i);
  });

  describe('the join dialog', () => {
    const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
      const created = remoteNode({ id: 'node-2', name: 'attic', enrolled: false });
      const client = createFakeClient({
        'GET /nodes': [localNode()],
        'GET /libraries': [],
        'GET /system/version': { commit: 'deadbeefcafe' },
        'POST /nodes': {
          node: mutationResponse(created),
          enrollToken: 'tok-secret',
          enrollExpiresAt: 1,
        },
      });
      renderNodes(client);
      await cardFor('This daemon');
      await user.click(screen.getByRole('button', { name: 'Add node' }));
      await user.type(screen.getByLabelText('Name'), 'attic');
      await user.click(screen.getByRole('button', { name: 'Add' }));
      await screen.findByRole('heading', { name: 'Add attic on the new machine' });
      return client;
    };

    it('shows both commands over the token, and shows the token only here', async () => {
      const user = userEvent.setup();
      await openDialog(user);

      const commands = screen.getAllByText(/tok-secret/);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toHaveTextContent(
        // `:sha-<7>`, never `:<version>`: a main build's version is 0.0.0,
        // which is never pushed, so that command failed as pasted.
        'ghcr.io/rgregg/trawlarr:sha-deadbee',
      );
      expect(commands[1]).toHaveTextContent('trawlarr node --server');

      // Once, and never again: leaving the dialog must not leave the token
      // rendered anywhere on the tab.
      await user.click(screen.getByRole('button', { name: 'Done' }));
      await cardFor('This daemon');
      expect(document.body.textContent ?? '').not.toContain('tok-secret');
    });

    it('rebuilds both commands when the Server URL is edited', async () => {
      const user = userEvent.setup();
      await openDialog(user);

      const field = screen.getByLabelText('Server URL');
      await user.clear(field);
      await user.type(field, 'https://trawlarr.example:8265/');

      await waitFor(() => {
        for (const command of screen.getAllByText(/tok-secret/)) {
          // Trailing slash dropped: `--server https://host/` double-slashes
          // every request path, and a trailing slash is what a browser's
          // address bar copies.
          expect(command).toHaveTextContent('https://trawlarr.example:8265');
          expect(command.textContent ?? '').not.toContain('example:8265/');
        }
      });
    });

    it('offers no command at all while the Server URL is unusable', async () => {
      const user = userEvent.setup();
      await openDialog(user);

      const field = screen.getByLabelText('Server URL');
      await user.clear(field);
      await user.type(field, 'trawlarr.example');

      expect(await screen.findByText('Not a URL.')).toBeInTheDocument();
      // A copyable command built from a broken URL is pasted before it is read.
      expect(screen.queryAllByText(/tok-secret/)).toHaveLength(0);
      expect(screen.queryAllByRole('button', { name: 'Copy' })).toHaveLength(0);
    });
  });
});
