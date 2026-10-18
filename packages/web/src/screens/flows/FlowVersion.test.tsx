/**
 * Restore is a publish, so it can return publish warnings. These pin the two behaviours:
 * warnings are shown (not navigated past unread), and with none the page navigates at once,
 * exactly as before warnings existed.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../../test/fake-api-client.js';
import { FlowVersion } from './FlowVersion.js';

const routes = (restore: Record<string, unknown>) => ({
  'GET /flows/f1/versions/v1': {
    id: 'v1',
    flowId: 'f1',
    definitionHash: 'aaaaaaaaaaaa',
    definition: { nodes: [], edges: [] },
    note: '',
    createdAt: 1,
  },
  'GET /flows/f1/versions?limit=1': {
    items: [{ id: 'v2', definitionHash: 'bbbbbbbbbbbb' }],
  },
  'GET /libraries': [],
  'POST /flows/f1/versions/v1/restore': restore,
});

const restoreVia = async (restore: Record<string, unknown>) => {
  const user = userEvent.setup();
  const navigated: string[] = [];
  const client = createFakeClient(routes(restore));
  render(
    <FlowVersion
      client={client}
      flowId="f1"
      versionId="v1"
      navigate={(to) => navigated.push(to)}
    />,
  );
  await user.click(await screen.findByRole('button', { name: 'Restore this version…' }));
  await user.click(screen.getByRole('button', { name: 'Yes, restore' }));
  return { navigated, client };
};

describe('FlowVersion restore', () => {
  it('shows the warnings and stays on the page, with a way to continue', async () => {
    const { navigated } = await restoreVia({
      id: 'f1',
      warnings: ['Send Webhook node "notify" names unknown destination "ops".'],
    });
    expect(await screen.findByText(/unknown destination "ops"/)).toBeInTheDocument();
    expect(navigated).toEqual([]);
    expect(screen.getByRole('link', { name: 'Continue to flow' })).toBeInTheDocument();
  });

  it('navigates immediately when there are no warnings', async () => {
    const { navigated } = await restoreVia({ id: 'f1' });
    await waitFor(() => {
      expect(navigated).toEqual(['/flows/f1']);
    });
  });

  it('navigates immediately when warnings is an empty list', async () => {
    const { navigated } = await restoreVia({ id: 'f1', warnings: [] });
    await waitFor(() => {
      expect(navigated).toEqual(['/flows/f1']);
    });
  });
});
