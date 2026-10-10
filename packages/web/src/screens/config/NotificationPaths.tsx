import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { describeFailure } from './library-form-model.js';
import { mapFromRows, rowsFromMap, type NotificationPathRow } from './notification-paths-model.js';

interface ScanSettingsResponse {
  scan: { notifyPathMap: { serverPath: string; nodePath: string }[] };
}

let nextRowKey = 0;
const newRowKey = (): string => {
  nextRowKey += 1;
  return `new-${String(nextRowKey)}`;
};

export const NotificationPathsSection = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [rows, setRows] = useState<NotificationPathRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await client.get<ScanSettingsResponse>('/system/settings');
        if (!cancelled) setRows(rowsFromMap(settings.scan.notifyPathMap));
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const save = async (): Promise<void> => {
    if (rows === null) return;
    setSaving(true);
    setFailure(null);
    try {
      const saved = await client.patch<ScanSettingsResponse>('/system/settings', {
        scan: { notifyPathMap: mapFromRows(rows) },
      });
      setRows(rowsFromMap(saved.scan.notifyPathMap));
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  const edit = (key: string, patch: Partial<NotificationPathRow>): void => {
    setRows((current) =>
      current === null
        ? current
        : current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  return (
    <div className="config-section">
      <h3>Notification paths</h3>
      {rows !== null && (
        <table>
          <thead>
            <tr>
              <th>Reported as</th>
              <th>Path here</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <input
                    aria-label="Reported as"
                    value={row.theirs}
                    onChange={(event) => {
                      edit(row.key, { theirs: event.target.value });
                    }}
                  />
                </td>
                <td>
                  <input
                    aria-label="Path here"
                    value={row.ours}
                    onChange={(event) => {
                      edit(row.key, { ours: event.target.value });
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setRows((current) =>
                        current === null ? current : current.filter((r) => r.key !== row.key),
                      );
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row-actions">
        <button
          type="button"
          onClick={() => {
            setRows((current) => [...(current ?? []), { key: newRowKey(), theirs: '', ours: '' }]);
          }}
        >
          Add row
        </button>
        <button type="button" disabled={saving || rows === null} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </div>
  );
};
