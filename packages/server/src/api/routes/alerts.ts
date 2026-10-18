import {
  SettingValidationError,
  type AlertDestination,
  type AlertSettings,
} from '../../db/settings-repo.js';
import { findDestinationReferences } from '../../alerts/flow-references.js';
import { createFlowRepo } from '../../db/flow-repo.js';
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
 *
 * A masked HEADER is kept only while the url is also kept. Otherwise a caller could point a
 * destination at their own host, leave `Authorization` masked, and have "send test" deliver the
 * stored bearer token to that host: the secret read back through a request. The same reasoning
 * is why the deliverer refuses redirects. Duplicate header names are paired by occurrence, so
 * each keeps its own stored value.
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
    let urlKept = false;
    if (typeof url === 'string' && url.includes(MASK)) {
      if (old === undefined || url !== maskUrl(old.url)) throw reenter('The url', name);
      url = old.url;
      urlKept = true;
    }
    let headers = raw.headers;
    if (Array.isArray(headers)) {
      const seen = new Map<unknown, number>();
      headers = headers.map((h: unknown): unknown => {
        if (!isRecord(h)) return h;
        const occurrence = seen.get(h.name) ?? 0;
        seen.set(h.name, occurrence + 1);
        if (h.value !== MASK) return h;
        const kept = urlKept
          ? old?.headers.filter((x) => x.name === h.name)[occurrence]
          : undefined;
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

/**
 * A destination a PUBLISHED flow names may not be removed or renamed: the node would silently
 * stop alerting on the next failure, and nothing would say so. Only the live definition counts
 * (what runs), not drafts or old versions. A rename is indistinguishable from remove-and-add,
 * so it is refused the same way. Runs before anything is stored.
 */
const refuseReferencedRemoval = (ctx: ApiContext, stored: AlertSettings, next: unknown): void => {
  if (!isRecord(next) || !Array.isArray(next.destinations)) return;
  const kept = new Set(
    next.destinations.flatMap((d: unknown) =>
      isRecord(d) && typeof d.name === 'string' ? [d.name] : [],
    ),
  );
  const gone = new Set(stored.destinations.map((d) => d.name).filter((n) => !kept.has(n)));
  if (gone.size === 0) return;
  const users = new Map<string, string[]>();
  for (const flow of createFlowRepo(ctx.db).list()) {
    for (const ref of findDestinationReferences(flow.definition)) {
      if (!gone.has(ref.destination)) continue;
      const list = users.get(ref.destination) ?? [];
      const label = `${flow.name} (${flow.id})`;
      if (!list.includes(label)) list.push(label);
      users.set(ref.destination, list);
    }
  }
  if (users.size === 0) return;
  const detail = [...users].map(([name, flows]) => `"${name}" in ${flows.join(', ')}`).join('; ');
  throw new ApiError(
    409,
    'destination-in-use',
    `Cannot remove or rename an alert destination a published flow uses: ${detail}. ` +
      `Change those flows first.`,
  );
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
      refuseReferencedRemoval(ctx, stored, next);
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
