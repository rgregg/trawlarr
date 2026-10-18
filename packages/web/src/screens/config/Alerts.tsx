import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import {
  ALERT_EVENTS,
  EVENT_LABELS,
  MASK,
  describeResult,
  formFromResource,
  isMasked,
  toPutBody,
  validateAlerts,
  type AlertsForm,
  type AlertsResource,
  type DeliveryOutcome,
  type DestinationForm,
  type HeaderForm,
} from './alerts-model.js';
import { describeFailure } from './library-form-model.js';

let nextKey = 0;
const newKey = (): string => {
  nextKey += 1;
  return `new-${String(nextKey)}`;
};

type TestState = { kind: 'running' } | { kind: 'done'; text: string; ok: boolean };

export const AlertsSection = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [loaded, setLoaded] = useState<AlertsResource | null>(null);
  const [form, setForm] = useState<AlertsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  // The masked text each field arrived with, by field key. Clearing a masked field on focus lets
  // a person type a replacement; leaving it empty must put the mask back, otherwise merely
  // tabbing through would blank a stored secret.
  const original = useRef(new Map<string, string>());

  const adopt = (resource: AlertsResource): void => {
    const next = formFromResource(resource);
    original.current = new Map(
      next.destinations.flatMap((d) => [
        [d.key, d.url] as const,
        ...d.headers.map((h) => [h.key, h.value] as const),
      ]),
    );
    setLoaded(resource);
    setForm(next);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resource = await client.get<AlertsResource>('/alerts');
        if (!cancelled) adopt(resource);
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const editDestination = (key: string, patch: Partial<DestinationForm>): void => {
    setInvalid(null);
    setForm((current) =>
      current === null
        ? current
        : {
            ...current,
            destinations: current.destinations.map((d) => (d.key === key ? { ...d, ...patch } : d)),
          },
    );
  };

  const editHeader = (destKey: string, headerKey: string, patch: Partial<HeaderForm>): void => {
    setInvalid(null);
    setForm((current) =>
      current === null
        ? current
        : {
            ...current,
            destinations: current.destinations.map((d) =>
              d.key === destKey
                ? {
                    ...d,
                    headers: d.headers.map((h) => (h.key === headerKey ? { ...h, ...patch } : h)),
                  }
                : d,
            ),
          },
    );
  };

  const save = async (): Promise<void> => {
    if (form === null || loaded === null) return;
    const problem = validateAlerts(form, loaded);
    if (problem !== null) {
      setInvalid(problem);
      return;
    }
    setSaving(true);
    setFailure(null);
    setInvalid(null);
    try {
      const saved = await client.put<AlertsResource>('/alerts', toPutBody(form, loaded));
      adopt(saved);
      setTests({});
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  const test = async (name: string): Promise<void> => {
    setTests((current) => ({ ...current, [name]: { kind: 'running' } }));
    try {
      const result = await client.post<DeliveryOutcome>(`/alerts/${encodeURIComponent(name)}/test`);
      setTests((current) => ({
        ...current,
        [name]: { kind: 'done', text: describeResult(result), ok: result.ok },
      }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [name]: { kind: 'done', text: describeFailure(error).message, ok: false },
      }));
    }
  };

  const restoreIfEmpty = (key: string, value: string, apply: (v: string) => void): void => {
    const was = original.current.get(key);
    if (value === '' && was !== undefined) apply(was);
  };

  const editable = form !== null && loaded !== null;
  const storedNames = new Set(loaded?.destinations.map((d) => d.name));

  return (
    <div className="config-section">
      <h3>Alerts</h3>
      {form === null && failure === null && <p aria-busy="true">Loading…</p>}
      {editable && (
        <>
          <label className="field">
            Public base URL
            <input
              aria-label="Public base URL"
              value={form.publicBaseUrl}
              disabled={saving}
              placeholder="https://trawlarr.example.com"
              onChange={(event) => {
                setInvalid(null);
                setForm({ ...form, publicBaseUrl: event.target.value });
              }}
            />
          </label>
          <ul className="alert-destinations">
            {form.destinations.map((d, index) => {
              const state = tests[d.name];
              return (
                <li key={d.key} role="group" aria-label={`Destination ${String(index + 1)}`}>
                  <div className="row-actions">
                    <input
                      aria-label="Name"
                      value={d.name}
                      disabled={saving}
                      onChange={(event) => {
                        editDestination(d.key, { name: event.target.value });
                      }}
                    />
                    <label>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Enabled"
                        checked={d.enabled}
                        disabled={saving}
                        onChange={(event) => {
                          editDestination(d.key, { enabled: event.target.checked });
                        }}
                      />{' '}
                      Enabled
                    </label>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setInvalid(null);
                        setForm({
                          ...form,
                          destinations: form.destinations.filter((x) => x.key !== d.key),
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <input
                    aria-label="URL"
                    autoComplete="off"
                    spellCheck={false}
                    value={d.url}
                    disabled={saving}
                    onFocus={() => {
                      if (isMasked(d.url)) editDestination(d.key, { url: '' });
                    }}
                    onBlur={() => {
                      restoreIfEmpty(d.key, d.url, (v) => {
                        editDestination(d.key, { url: v });
                      });
                    }}
                    onChange={(event) => {
                      editDestination(d.key, { url: event.target.value });
                    }}
                  />
                  <div className="alert-events">
                    {ALERT_EVENTS.map((event) => (
                      <label key={event}>
                        <input
                          type="checkbox"
                          checked={d.events[event] === true}
                          disabled={saving}
                          onChange={(e) => {
                            editDestination(d.key, {
                              events: { ...d.events, [event]: e.target.checked },
                            });
                          }}
                        />{' '}
                        {EVENT_LABELS[event]}
                      </label>
                    ))}
                  </div>
                  {d.headers.map((h) => (
                    <div key={h.key} className="row-actions">
                      <input
                        aria-label="Header name"
                        value={h.name}
                        disabled={saving}
                        onChange={(event) => {
                          editHeader(d.key, h.key, { name: event.target.value });
                        }}
                      />
                      <input
                        aria-label="Header value"
                        autoComplete="off"
                        spellCheck={false}
                        value={h.value}
                        disabled={saving}
                        onFocus={() => {
                          if (h.value === MASK) editHeader(d.key, h.key, { value: '' });
                        }}
                        onBlur={() => {
                          restoreIfEmpty(h.key, h.value, (v) => {
                            editHeader(d.key, h.key, { value: v });
                          });
                        }}
                        onChange={(event) => {
                          editHeader(d.key, h.key, { value: event.target.value });
                        }}
                      />
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          editDestination(d.key, {
                            headers: d.headers.filter((x) => x.key !== h.key),
                          });
                        }}
                      >
                        Remove header
                      </button>
                    </div>
                  ))}
                  <div className="row-actions">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        editDestination(d.key, {
                          headers: [...d.headers, { key: newKey(), name: '', value: '' }],
                        });
                      }}
                    >
                      Add header
                    </button>
                    {/* The daemon tests what is STORED under a name, so an unsaved or renamed
                        destination has nothing to test yet. */}
                    <button
                      type="button"
                      disabled={saving || !storedNames.has(d.name) || state?.kind === 'running'}
                      onClick={() => void test(d.name)}
                    >
                      Test
                    </button>
                    {state?.kind === 'running' && <span role="status">Testing…</span>}
                    {state?.kind === 'done' && (
                      <span role="status" className={state.ok ? 'detail' : 'problem'}>
                        {state.text}
                      </span>
                    )}
                    {state === undefined && d.lastResult !== undefined && (
                      <span className="detail">Last: {describeResult(d.lastResult)}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="row-actions">
        <button
          type="button"
          disabled={saving || !editable}
          onClick={() => {
            if (form === null) return;
            setInvalid(null);
            setForm({
              ...form,
              destinations: [
                ...form.destinations,
                {
                  key: newKey(),
                  name: '',
                  enabled: true,
                  events: Object.fromEntries(ALERT_EVENTS.map((e) => [e, true])),
                  url: '',
                  headers: [],
                },
              ],
            });
          }}
        >
          Add destination
        </button>
        <button type="button" disabled={saving || !editable} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {invalid !== null && (
        <p role="alert" className="problem">
          {invalid}
        </p>
      )}
      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </div>
  );
};
