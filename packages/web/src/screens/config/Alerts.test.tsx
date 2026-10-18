/**
 * Component tests for the "Alerts" section. The model tests cover the rules; these drive the
 * rendered section against the recording fake client and assert the exact PUT the daemon sees.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../api/client.js';
import { createFakeClient } from '../../test/fake-api-client.js';
import { AlertsSection } from './Alerts.js';
import { ALERT_EVENTS } from './alerts-model.js';

const events = (on: boolean): Record<string, boolean> =>
  Object.fromEntries(ALERT_EVENTS.map((e) => [e, on]));

const resource = () => ({
  publicBaseUrl: 'https://trawlarr.lan',
  destinations: [
    {
      name: 'ops',
      enabled: true,
      events: events(true),
      url: 'https://hooks.example.com/••••',
      headers: [{ name: 'Authorization', value: '••••' }],
      lastResult: { ok: false, status: 503, error: 'HTTP 503', atMs: 1 },
    },
    {
      name: 'backup',
      enabled: false,
      events: events(false),
      url: 'https://other.example.com/••••',
      headers: [],
    },
  ],
});

const row = (n: number) => screen.getByRole('group', { name: `Destination ${String(n)}` });

describe('AlertsSection', () => {
  it('renders a row per destination with masked values, switches, event toggles and last result', async () => {
    render(<AlertsSection client={createFakeClient({ 'GET /alerts': resource() })} />);
    await screen.findByDisplayValue('ops');
    const first = within(row(1));
    expect(first.getByLabelText('URL')).toHaveValue('https://hooks.example.com/••••');
    expect(first.getByLabelText('Header value')).toHaveValue('••••');
    expect(first.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    expect(first.getByRole('checkbox', { name: 'Node offline' })).toBeChecked();
    expect(first.getByText('Last: HTTP 503')).toBeInTheDocument();
    expect(within(row(2)).getByRole('switch', { name: 'Enabled' })).not.toBeChecked();
    expect(screen.getByLabelText('Public base URL')).toHaveValue('https://trawlarr.lan');
    expect(screen.getByRole('heading', { name: 'Alerts' })).toBeInTheDocument();
  });

  it('keeps copy terse: no help paragraph', async () => {
    const { container } = render(
      <AlertsSection client={createFakeClient({ 'GET /alerts': resource() })} />,
    );
    await screen.findByDisplayValue('ops');
    expect(container.querySelector('p.help')).toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('sends untouched secrets back masked and a typed url as the new value', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({
      'GET /alerts': resource(),
      'PUT /alerts': resource(),
    });
    render(<AlertsSection client={client} />);
    await screen.findByDisplayValue('ops');

    // Focusing and leaving a masked field must not blank the stored secret.
    await user.click(within(row(2)).getByLabelText('URL'));
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(client.signatures()).toContain('PUT /alerts');
    });
    const first = client.calls.find((c) => c.method === 'PUT')?.body as {
      destinations: Array<{ url: string; headers: Array<{ value: string }> }>;
    };
    expect(first.destinations[0]?.url).toBe('https://hooks.example.com/••••');
    expect(first.destinations[0]?.headers[0]?.value).toBe('••••');
    expect(first.destinations[1]?.url).toBe('https://other.example.com/••••');

    await user.click(within(row(2)).getByLabelText('URL'));
    await user.type(within(row(2)).getByLabelText('URL'), 'https://new.example.com/hook');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(client.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    });
    const second = client.calls.filter((c) => c.method === 'PUT')[1]?.body as {
      destinations: Array<{ url: string }>;
    };
    expect(second.destinations[1]?.url).toBe('https://new.example.com/hook');
  });

  it('refuses a renamed destination without a fresh url instead of sending it', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({ 'GET /alerts': resource(), 'PUT /alerts': resource() });
    render(<AlertsSection client={client} />);
    await screen.findByDisplayValue('ops');
    await user.type(within(row(1)).getByLabelText('Name'), '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ops2');
    expect(client.signatures()).not.toContain('PUT /alerts');
  });

  it('shows the daemon 400 and 409 text as received', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({
      'GET /alerts': resource(),
      'PUT /alerts': () =>
        Promise.reject(
          new ApiClientError({
            status: 409,
            code: 'destination-in-use',
            message:
              'Cannot remove or rename an alert destination a published flow uses: "ops" in Main (f1).',
          }),
        ),
    });
    render(<AlertsSection client={client} />);
    await screen.findByDisplayValue('ops');
    await user.click(within(row(1)).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/"ops" in Main \(f1\)/)).toBeInTheDocument();

    client.route('PUT /alerts', () =>
      Promise.reject(
        new ApiClientError({ status: 400, code: 'invalid-setting', message: 'Bad publicBaseUrl.' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Bad publicBaseUrl.')).toBeInTheDocument();
  });

  it('removes a destination from the PUT body', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({ 'GET /alerts': resource(), 'PUT /alerts': resource() });
    render(<AlertsSection client={client} />);
    await screen.findByDisplayValue('ops');
    await user.click(within(row(2)).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(client.signatures()).toContain('PUT /alerts');
    });
    const body = client.calls.find((c) => c.method === 'PUT')?.body as {
      destinations: Array<{ name: string }>;
    };
    expect(body.destinations.map((d) => d.name)).toEqual(['ops']);
  });

  it('adds a destination with a fresh url and header and sends the public base url', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({ 'GET /alerts': resource(), 'PUT /alerts': resource() });
    render(<AlertsSection client={client} />);
    await screen.findByDisplayValue('ops');
    await user.click(screen.getByRole('button', { name: 'Add destination' }));
    const added = within(row(3));
    await user.type(added.getByLabelText('Name'), 'chat');
    await user.type(added.getByLabelText('URL'), 'https://chat.example.com/h');
    await user.click(added.getByRole('button', { name: 'Add header' }));
    await user.type(added.getByLabelText('Header name'), 'X-Token');
    await user.type(added.getByLabelText('Header value'), 'abc');
    const base = screen.getByLabelText('Public base URL');
    await user.clear(base);
    await user.type(base, 'https://x.example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(client.signatures()).toContain('PUT /alerts');
    });
    const body = client.calls.find((c) => c.method === 'PUT')?.body as {
      publicBaseUrl: string;
      destinations: Array<{ name: string; url: string; headers: unknown[] }>;
    };
    expect(body.publicBaseUrl).toBe('https://x.example.com');
    expect(body.destinations[2]).toMatchObject({
      name: 'chat',
      url: 'https://chat.example.com/h',
      headers: [{ name: 'X-Token', value: 'abc' }],
    });
  });

  it('shows the test result inline, and failures as a short line', async () => {
    const user = userEvent.setup();
    const client = createFakeClient({
      'GET /alerts': resource(),
      'POST /alerts/ops/test': { ok: true, status: 200, error: null, atMs: 2 },
      'POST /alerts/backup/test': { ok: false, status: null, error: 'timeout', atMs: 2 },
    });
    render(<AlertsSection client={client} />);
    await screen.findByDisplayValue('ops');
    await user.click(within(row(1)).getByRole('button', { name: 'Test' }));
    expect(await within(row(1)).findByText('200 OK')).toBeInTheDocument();
    await user.click(within(row(2)).getByRole('button', { name: 'Test' }));
    expect(await within(row(2)).findByText('timeout')).toBeInTheDocument();
  });

  it('shows a load failure and offers no editing', async () => {
    const client = createFakeClient({});
    render(<AlertsSection client={client} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
