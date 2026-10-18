/**
 * The "Alerts" setting as a form a person edits.
 *
 * The daemon never returns a destination's url or header values: it returns a mask, and treats a
 * mask on PUT as "keep what is stored under this destination name". Everything here exists to
 * keep that contract honest without a secret ever being held, logged or put in a message:
 * an untouched masked field goes back exactly as received, and a field that cannot be kept
 * (new or renamed destination, replaced url) must be typed fresh, which is checked here rather
 * than left to a server 400.
 */

/**
 * Mirrors `ALERT_EVENT_TYPES` in @trawlarr/core. Mirrored, not imported, so the web bundle takes
 * no runtime dependency on core for a list of seven strings; `alerts-model.test.ts` fails if the
 * two drift, which is what stops a new event type being silently unconfigurable in the UI.
 */
export const ALERT_EVENTS = [
  'file.failed',
  'file.not_converging',
  'node.offline',
  'library.root_missing',
  'scan.aborted',
  'library.paused',
  'hardware.check_failed',
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export const EVENT_LABELS: Record<AlertEvent, string> = {
  'file.failed': 'File failed',
  'file.not_converging': 'Not converging',
  'node.offline': 'Node offline',
  'library.root_missing': 'Root missing',
  'scan.aborted': 'Scan aborted',
  'library.paused': 'Library paused',
  'hardware.check_failed': 'Hardware check failed',
};

/** What the daemon substitutes for every secret. Must equal `MASK` in the server's alerts route. */
export const MASK = '••••';

export interface DeliveryOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}
export interface LastResult extends DeliveryOutcome {
  atMs: number;
}

export interface AlertsResource {
  publicBaseUrl: string;
  destinations: Array<{
    name: string;
    enabled: boolean;
    events: Record<string, boolean>;
    url: string;
    headers: Array<{ name: string; value: string }>;
    lastResult?: LastResult;
  }>;
}

export interface HeaderForm {
  key: string;
  name: string;
  value: string;
}
export interface DestinationForm {
  key: string;
  name: string;
  enabled: boolean;
  events: Record<string, boolean>;
  url: string;
  headers: HeaderForm[];
  lastResult?: LastResult;
}
export interface AlertsForm {
  publicBaseUrl: string;
  destinations: DestinationForm[];
}

export interface AlertsPutBody {
  publicBaseUrl: string;
  destinations: Array<{
    name: string;
    enabled: boolean;
    events: Record<string, boolean>;
    url: string;
    headers: Array<{ name: string; value: string }>;
  }>;
}

export const formFromResource = (resource: AlertsResource): AlertsForm => ({
  publicBaseUrl: resource.publicBaseUrl,
  destinations: resource.destinations.map((d, i) => ({
    key: `loaded-${String(i)}-${d.name}`,
    name: d.name,
    enabled: d.enabled,
    events: { ...d.events },
    url: d.url,
    headers: d.headers.map((h, j) => ({ key: `loaded-${String(i)}-${String(j)}`, ...h })),
    ...(d.lastResult === undefined ? {} : { lastResult: d.lastResult }),
  })),
});

export const isMasked = (value: string): boolean => value.includes(MASK);

/** A header name is an HTTP token (RFC 9110). Mirrors the daemon's check. */
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Rules that need only this one destination. Messages never include a url or header value. */
export const validateDestination = (d: DestinationForm): string | null => {
  const name = d.name.trim();
  if (name === '') return 'Every destination needs a name.';
  const at = `"${name}"`;
  let parsed: URL | null = null;
  try {
    parsed = new URL(d.url.trim());
  } catch {
    // A masked url is not a url; whether it may stand is `validateAlerts`'s question.
    if (!isMasked(d.url)) return `${at}: url must start with http:// or https://.`;
  }
  if (parsed !== null && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${at}: url must start with http:// or https://.`;
  }
  for (const h of d.headers) {
    if (h.name.trim() === '') return `${at}: a header has no name.`;
    if (!HEADER_NAME_TOKEN.test(h.name)) {
      return `${at}: "${h.name}" is not a valid header name.`;
    }
  }
  return null;
};

/**
 * Whether the daemon would keep this destination's stored url: only when the masked text is
 * exactly what it returned for a destination of the SAME name. Anything else is a request the
 * daemon refuses (a rename, or a masked url pasted into another destination).
 */
const urlIsKept = (d: DestinationForm, loaded: AlertsResource): boolean => {
  const old = loaded.destinations.find((x) => x.name === d.name);
  return old !== undefined && d.url === old.url;
};

/**
 * Everything that must hold before Save is sent. Checking the "re-enter" cases here saves a
 * round trip, and keeps the explanation next to the field instead of in a server error.
 */
export const validateAlerts = (form: AlertsForm, loaded: AlertsResource): string | null => {
  const seen = new Set<string>();
  for (const d of form.destinations) {
    const problem = validateDestination(d);
    if (problem !== null) return problem;
    if (seen.has(d.name)) return `"${d.name}": names must be unique.`;
    seen.add(d.name);

    const kept = urlIsKept(d, loaded);
    if (isMasked(d.url) && !kept) return `"${d.name}": re-enter the url.`;
    const old = loaded.destinations.find((x) => x.name === d.name);
    const occurrences = new Map<string, number>();
    for (const h of d.headers) {
      const n = occurrences.get(h.name) ?? 0;
      occurrences.set(h.name, n + 1);
      if (h.value !== MASK) continue;
      const stored = old?.headers.filter((x) => x.name === h.name)[n];
      // A masked header survives only beside a kept url (otherwise the stored token could be
      // sent to a url the person just pointed elsewhere) and only while the header exists.
      if (!kept || stored === undefined)
        return `"${d.name}": re-enter the "${h.name}" header value.`;
    }
  }
  return null;
};

export const toPutBody = (form: AlertsForm, loaded: AlertsResource): AlertsPutBody => {
  void loaded; // Masked values are already what the daemon returned; kept for symmetry with validateAlerts.
  return {
    publicBaseUrl: form.publicBaseUrl.trim(),
    destinations: form.destinations.map((d) => ({
      name: d.name.trim(),
      enabled: d.enabled,
      events: d.events,
      url: isMasked(d.url) ? d.url : d.url.trim(),
      headers: d.headers.map((h) => ({ name: h.name.trim(), value: h.value })),
    })),
  };
};

/** One short line for a test or last-delivery result: `200 OK`, `HTTP 503`, `timeout`. */
export const describeResult = (r: DeliveryOutcome): string => {
  if (r.ok) return r.status === null ? 'OK' : `${String(r.status)} OK`;
  if (r.error !== null && r.error !== '') return r.error;
  if (r.status !== null) return `HTTP ${String(r.status)}`;
  return 'failed';
};
