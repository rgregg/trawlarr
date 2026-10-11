/**
 * Component tests for the "Notification paths" section.
 *
 * `notification-paths-model.test.ts` covers the row/map conversion. What it
 * cannot cover is what the rendered section lets a person do while a request
 * is outstanding, so these drive the real component with the recording fake
 * `ApiClient` and hold the save open.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeClient } from '../../test/fake-api-client.js';
import { NotificationPathsSection } from './NotificationPaths.js';

const settings = (map: { serverPath: string; nodePath: string }[]) => ({
  scan: { notifyPathMap: map },
});

describe('NotificationPathsSection', () => {
  it('locks every edit while a save is in flight, because the answer replaces the rows', async () => {
    const user = userEvent.setup();
    const saved = [{ serverPath: '/library/tv', nodePath: '/data/tv' }];
    let answer: (value: unknown) => void = () => undefined;
    const client = createFakeClient({
      'GET /system/settings': settings(saved),
      'PATCH /system/settings': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    render(<NotificationPathsSection client={client} />);

    await screen.findByDisplayValue('/data/tv');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The save has been sent and has not answered. Anything typed, added or
    // removed now would be thrown away when it does.
    await screen.findByRole('button', { name: 'Saving…' });
    expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByLabelText('Reported as')).toBeDisabled();
    expect(screen.getByLabelText('Path here')).toBeDisabled();

    answer(settings(saved));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add row' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(screen.getByLabelText('Reported as')).toBeEnabled();
    expect(screen.getByLabelText('Path here')).toBeEnabled();
  });
});
