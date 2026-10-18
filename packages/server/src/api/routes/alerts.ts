import {
  SettingValidationError,
  type AlertDestination,
  type AlertSettings,
} from '../../db/settings-repo.js';
import { ApiError, type ApiContext, type Route } from '../router.js';

/** What stands in for every secret in a response. */
export const MASK = '••••';

/**
 * The origin plus a mask, so an operator can tell destinations apart without the path or query
 * (where a webhook's token lives) ever leaving the daemon. Userinfo is not in `origin`, which is
 * also deliberate: `https://user:pass@host` must not survive masking.
 */
export const maskUrl = (url: string): string => {
  try {
    return `${new URL(url).origin}/${MASK}`;
  } catch {
    return MASK;
  }
};

/**
 * Stored settings, or a 500 that names nothing. A hand-edited or corrupt section makes the
 * repo throw, and its message can carry the offending value (a token pasted in the wrong field),
 * so the text is replaced rather than passed on.
 */
const readStored = (ctx: ApiContext): AlertSettings => {
  try {
    return ctx.settings.getAlerts();
  } catch {
    throw new ApiError(
      500,
      'alerts-unreadable',
      'The stored alert settings could not be read. Save the alerts again, re-entering each ' +
        'destination url and header value, to replace them.',
    );
  }
};

const present = (ctx: ApiContext, settings: AlertSettings) => ({
  publicBaseUrl: settings.publicBaseUrl,
  destinations: settings.destinations.map((d) => {
    const lastResult = ctx.alerts.lastResult(d.name);
    return {
      name: d.name,
      enabled: d.enabled,
      events: d.events,
      url: maskUrl(d.url),
      headers: d.headers.map((h) => ({ name: h.name, value: MASK })),
      ...(lastResult === undefined ? {} : { lastResult }),
    };
  }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const reenter = (what: string, name: string): ApiError =>
  new ApiError(
    400,
    'reenter-secret',
    `${what} for destination "${name}" is hidden and has nothing stored to keep for this name: ` +
      `re-enter it.`,
  );

/**
 * Turn the shape GET returned back into storable settings.
 *
 * A masked value is only ever a request to KEEP what is stored under the same destination name
 * (and, for a header, the same header name). Honouring it anywhere else would either save the
 * literal mask as a secret, which then fails every delivery with no clue why, or let a rename
 * silently adopt another destination's secret.
 */
const merge = (body: unknown, stored: AlertSettings): unknown => {
  if (!isRecord(body)) return body;
  if (!Array.isArray(body.destinations)) return body;
  const byName = new Map(stored.destinations.map((d) => [d.name, d]));
  const destinations = body.destinations.map((raw: unknown): unknown => {
    if (!isRecord(raw)) return raw;
    const name = typeof raw.name === 'string' ? raw.name : '';
    const old: AlertDestination | undefined = byName.get(name);
    let url = raw.url;
    if (typeof url === 'string' && url.includes(MASK)) {
      if (old === undefined || url !== maskUrl(old.url)) throw reenter('The url', name);
      url = old.url;
    }
    let headers = raw.headers;
    if (Array.isArray(headers)) {
      headers = headers.map((h: unknown): unknown => {
        if (!isRecord(h) || h.value !== MASK) return h;
        const kept = old?.headers.find((x) => x.name === h.name);
        if (kept === undefined) {
          throw reenter(`The value of header "${typeof h.name === 'string' ? h.name : ''}"`, name);
        }
        return { name: h.name, value: kept.value };
      });
    }
    // Only the storable fields: `lastResult` is a read-only report.
    return { name: raw.name, url, headers, events: raw.events, enabled: raw.enabled };
  });
  return { publicBaseUrl: body.publicBaseUrl, destinations };
};

export const alertRoutes: Route[] = [
  {
    method: 'GET',
    path: '/alerts',
    handler: ({ ctx }) => present(ctx, readStored(ctx)),
  },

  {
    method: 'PUT',
    path: '/alerts',
    handler: ({ body, ctx }) => {
      // A corrupt stored section must not lock the operator out of replacing it: with nothing
      // readable there is nothing to keep, so masked values are refused and fresh ones save.
      let stored: AlertSettings = { publicBaseUrl: '', destinations: [] };
      try {
        stored = ctx.settings.getAlerts();
      } catch {
        // See above.
      }
      const next = merge(body, stored);
      try {
        ctx.settings.setAlerts(next as AlertSettings);
      } catch (error) {
        // The repo's text names the field and never echoes a url or header value.
        if (error instanceof SettingValidationError) {
          throw new ApiError(400, 'invalid-setting', error.message);
        }
        throw error;
      }
      return present(ctx, readStored(ctx));
    },
  },

  {
    method: 'POST',
    path: '/alerts/:name/test',
    handler: async ({ params, ctx }) => {
      const name = params.name ?? '';
      if (!readStored(ctx).destinations.some((d) => d.name === name)) {
        throw new ApiError(404, 'destination-not-found', `No alert destination named "${name}".`);
      }
      // The only way to verify a destination: the stored secret is never readable back.
      return await ctx.alerts.sendTest(name);
    },
  },
];
