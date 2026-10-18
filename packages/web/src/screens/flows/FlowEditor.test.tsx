/**
 * Publish warnings in the editor: shown beside the "Published" message as a notice, never as an
 * error, and absent when the daemon sends none.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeClient } from '../../test/fake-api-client.js';
import { FlowEditor } from './FlowEditor.js';

beforeAll(() => {
  // jsdom has no <dialog> modal support; the publish dialog calls these.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const definition = { nodes: [], edges: [] };
const flow = {
  id: 'f1',
  name: 'Main',
  description: null,
  definition,
  definitionHash: 'live',
  draft: definition,
  draftBaseHash: 'live',
  draftUpdatedAt: 1,
  layout: {},
};

const publishWith = async (published: Record<string, unknown>) => {
  const user = userEvent.setup();
  const client = createFakeClient({
    'GET /flows/f1': flow,
    'GET /plugins': [],
    'GET /flows/fields': { fields: [] },
    'POST /flows/validate': { ok: true, problems: [], definitionHash: 'next' },
    'PUT /flows/f1/draft': { flow, ok: true, problems: [], definitionHash: 'next' },
    'GET /libraries': [],
    'PUT /flows/f1': { ...flow, ...published },
  });
  render(<FlowEditor client={client} id="f1" navigate={() => undefined} />);
  const review = await screen.findByRole('button', { name: /Review & publish/ });
  // Validation is debounced; the button stays disabled until the daemon has vouched for the graph.
  await waitFor(() => {
    expect(review).toBeEnabled();
  });
  await user.click(review);
  const confirm = await screen.findByRole('button', { name: 'Confirm publish' });
  await screen.findByText(/Hash:/);
  await user.click(confirm);
};

describe('FlowEditor publish', () => {
  it('shows returned warnings as a notice beside the published message', async () => {
    await publishWith({
      warnings: ['Send Webhook node "notify" names unknown destination "ops".'],
    });
    expect(await screen.findByText(/^Published\. This version is now live/)).toBeInTheDocument();
    const notice = await screen.findByRole('note');
    expect(notice).toHaveTextContent('unknown destination "ops"');
    expect(notice.closest('[role="alert"]')).toBeNull();
  });

  it('shows no notice when the daemon sends no warnings', async () => {
    await publishWith({});
    expect(await screen.findByText(/^Published\. This version is now live/)).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
