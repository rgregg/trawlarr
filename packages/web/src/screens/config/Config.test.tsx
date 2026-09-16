/**
 * Component tests for the Configure screen's Workers tab.
 *
 * Narrow on purpose: this is the one control that starts and stops every
 * transcode the daemon will run, and the two things worth a DOM for are the
 * two numbers it prints (they answer different questions and were once the
 * same number) and the save round trip. Everything else on this screen stays
 * covered by `config-model.test.ts`.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountResource } from '../../api/session.js';
import { initialLiveState } from '../../api/events.js';
import { createFakeClient } from '../../test/fake-api-client.js';
import { Config } from './Config.js';

const account: AccountResource = {
  id: 'acct-1',
  username: 'ryan',
  displayName: null,
  loginMethod: 'password',
  createdAt: 1_760_000_000_000,
  lastLoginAt: null,
};

const renderWorkers = (client: ReturnType<typeof createFakeClient>) =>
  render(
    <Config
      client={client}
      live={initialLiveState}
      tab="workers"
      account={account}
      navigate={() => undefined}
    />,
  );

describe('Workers tab', () => {
  it('shows the schedule’s ask and this node’s active count, not the all-nodes total', async () => {
    const client = createFakeClient({
      'GET /workers': {
        paused: false,
        // A window is in force, so `target` differs from `baseCounts` — the
        // reason the two are labelled separately at all.
        target: { transcode: 3, health: 1 },
        baseCounts: { transcode: 2, health: 1 },
        // Every worker on every node. Printing THIS beside `target` reads as
        // "asked for 3, running 5", which is false: two of those five are a
        // remote node's, which `target` never asked for.
        active: 5,
        workers: [
          { nodeId: 'local' },
          { nodeId: 'local' },
          { nodeId: 'node-1' },
          { nodeId: 'node-1' },
          { nodeId: 'node-1' },
        ],
      },
    });
    renderWorkers(client);

    const line = await screen.findByText(/Running right now/);
    expect(line).toHaveTextContent('transcode 3, health check 1, 2 active on this node.');
    expect(line.textContent ?? '').not.toContain('5 active');

    // `baseCounts` — the permanent number — is what the fields edit, never
    // `target`.
    expect(await screen.findByLabelText('Transcode workers')).toHaveValue('2');
    expect(screen.getByLabelText('Health check workers')).toHaveValue('1');
  });

  it('saves the typed counts and re-seeds the fields from the response', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({
      'GET /workers': {
        paused: false,
        target: { transcode: 2, health: 1 },
        baseCounts: { transcode: 2, health: 1 },
        active: 0,
        workers: [],
      },
      'PUT /workers/counts': (body) => {
        const counts = body as { transcode: number; health: number };
        return { paused: false, target: counts, baseCounts: counts, active: 0, workers: [] };
      },
    });
    renderWorkers(client);

    const field = await screen.findByLabelText('Transcode workers');
    await user.clear(field);
    await user.type(field, '4');
    await user.click(screen.getByRole('button', { name: 'Save worker counts' }));

    await waitFor(() => {
      expect(client.signatures()).toContain('PUT /workers/counts');
    });
    expect(client.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      transcode: 4,
      health: 1,
    });
    await waitFor(() => {
      expect(screen.getByText(/Running right now/)).toHaveTextContent('transcode 4');
    });
  });

  it('refuses to save a cleared box, which is not a request for zero workers', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({
      'GET /workers': {
        paused: false,
        target: { transcode: 2, health: 1 },
        baseCounts: { transcode: 2, health: 1 },
        active: 0,
        workers: [],
      },
      // No `PUT /workers/counts` route: a save that gets through fails loudly.
    });
    renderWorkers(client);

    await user.clear(await screen.findByLabelText('Transcode workers'));

    expect(screen.getByText('Enter a number of workers. An empty box is not zero.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save worker counts' })).toBeDisabled();
    expect(client.signatures().every((signature) => signature.startsWith('GET '))).toBe(true);
  });
});
