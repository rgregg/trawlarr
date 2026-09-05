import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import * as client from 'openid-client';
import type { AuthSettings } from '../db/settings-repo.js';

/**
 * The cookie the OIDC round trip lives in between the redirect out to the
 * provider and the redirect back. `Lax`, not `Strict` — see
 * `serializeOidcTransactionCookie` for why the session cookie proper can be
 * `Strict` but this one cannot.
 */
export const OIDC_TRANSACTION_COOKIE = 'trawlarr_oidc_txn';

/** Long enough for a human to authenticate at the provider; short enough that a stale attempt is useless. */
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to send the browser once login succeeds — the page it started from. */
  returnTo: string;
}

/**
 * Sign the PKCE verifier, `state` and `nonce` into a cookie, rather than
 * keeping them in a server-side store. There is no session store anywhere
 * else in this daemon (see `session.ts`), and a transaction store would be
 * the one exception — one this small does not earn.
 */
export const issueOidcTransactionToken = async (
  input: OidcTransaction & { secret: string; nowMs: number },
): Promise<string> => {
  const now = Math.floor(input.nowMs / 1000);
  return await new SignJWT({
    state: input.state,
    nonce: input.nonce,
    codeVerifier: input.codeVerifier,
    returnTo: input.returnTo,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + Math.floor(TRANSACTION_TTL_MS / 1000))
    .sign(new TextEncoder().encode(input.secret));
};

export const verifyOidcTransactionToken = async (input: {
  token: string;
  secret: string;
}): Promise<OidcTransaction | null> => {
  try {
    const { payload } = await jwtVerify(input.token, new TextEncoder().encode(input.secret));
    if (
      typeof payload.state !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.codeVerifier !== 'string' ||
      typeof payload.returnTo !== 'string'
    ) {
      return null;
    }
    return {
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
      returnTo: payload.returnTo,
    };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) return null;
    throw error;
  }
};

/**
 * `SameSite=Lax`, unlike the session cookie: the browser arrives back at
 * `/auth/oidc/callback` via a 302 issued by the PROVIDER's origin, which is
 * a cross-site top-level navigation. `Strict` cookies are withheld on
 * exactly that navigation, which would make the transaction cookie invisible
 * to the one request that needs it. `Lax` still withholds the cookie from
 * subresource requests and non-navigations, which is what keeps this from
 * being the CSRF exposure `Strict` exists to close on the session cookie.
 */
export const serializeOidcTransactionCookie = (input: {
  token: string;
  secure: boolean;
}): string => {
  const attrs = [
    `${OIDC_TRANSACTION_COOKIE}=${encodeURIComponent(input.token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(Math.floor(TRANSACTION_TTL_MS / 1000))}`,
  ];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
};

export const serializeClearedOidcTransactionCookie = (input: { secure: boolean }): string => {
  const attrs = [`${OIDC_TRANSACTION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
};

/**
 * One discovered `Configuration` per distinct provider setup, cached rather
 * than rediscovered on every login: discovery is a network round trip to the
 * provider's `.well-known` document, and doing it per-request would mean a
 * moment of provider slowness or downtime shows up as trawlarr's own login
 * being slow. The cache key is every field that changes what gets
 * discovered or how the client authenticates, so editing any of them in
 * Settings invalidates it on the very next login attempt.
 */
let cached: { key: string; config: Promise<client.Configuration> } | null = null;

const cacheKey = (auth: AuthSettings): string =>
  JSON.stringify([auth.oidcIssuer, auth.oidcClientId, auth.oidcClientSecret]);

export class OidcConfigurationError extends Error {
  constructor(issuer: string) {
    super(
      `Could not discover the OIDC provider's configuration at "${issuer}". Check ` +
        `auth.oidcIssuer against the provider's issuer URL — it usually has no trailing path ` +
        `beyond the realm/application segment the provider documents.`,
    );
    this.name = 'OidcConfigurationError';
  }
}

export const getOidcConfiguration = async (auth: AuthSettings): Promise<client.Configuration> => {
  const key = cacheKey(auth);
  if (cached !== null && cached.key === key) return await cached.config;
  const config = client
    .discovery(new URL(auth.oidcIssuer), auth.oidcClientId, auth.oidcClientSecret)
    .catch((): never => {
      cached = null;
      throw new OidcConfigurationError(auth.oidcIssuer);
    });
  cached = { key, config };
  return await config;
};

/** Test-only: forces the next `getOidcConfiguration` call to rediscover. */
export const resetOidcConfigurationCache = (): void => {
  cached = null;
};

export { client };
