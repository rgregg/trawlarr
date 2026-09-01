import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/** The cookie a browser session lives in. Never sent to a non-browser client. */
export const SESSION_COOKIE_NAME = 'trawlarr_session';

/** How long a session is good for before the browser must sign in again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  /** The `account.id` this session was issued for. */
  sub: string;
}

/**
 * Sign a session token for an account.
 *
 * HS256 over `settings.getAuth().sessionSecret` — that secret is generated
 * once per daemon (see `settings-repo.ts`) and never leaves it, so signing
 * and verifying are both things only this daemon can do. There is no
 * server-side session store: the token itself, plus `exp`, is the whole of
 * the session state, which is what makes it fine for two daemon processes
 * behind a load balancer to share nothing but the secret.
 */
export const issueSessionToken = async (input: {
  accountId: string;
  secret: string;
  nowMs: number;
  ttlMs?: number;
}): Promise<string> => {
  const now = Math.floor(input.nowMs / 1000);
  const ttlMs = input.ttlMs ?? SESSION_TTL_MS;
  return await new SignJWT({ sub: input.accountId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + Math.floor(ttlMs / 1000))
    .sign(new TextEncoder().encode(input.secret));
};

/**
 * Verify a session token, returning the account id or `null`.
 *
 * `null` covers every way a token can fail — expired, forged, malformed, cut
 * off mid-string by a truncated cookie header — because none of them is a
 * distinction a caller should act on differently: every one of them means
 * "this browser is not signed in," and the response is the same 401 either
 * way.
 */
export const verifySessionToken = async (input: {
  token: string;
  secret: string;
}): Promise<string | null> => {
  try {
    const { payload } = await jwtVerify(input.token, new TextEncoder().encode(input.secret));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) return null;
    throw error;
  }
};

/**
 * Split a `Cookie` request header into its name/value pairs.
 *
 * Hand-rolled rather than a dependency: this is the one header this daemon
 * ever reads as a cookie jar, and the format (`name=value; name=value`) is
 * simple enough that a small, obviously-correct parser is more auditable
 * than a general-purpose one built for every attribute a `Set-Cookie` can
 * carry.
 */
export const parseCookies = (header: string | undefined): Record<string, string> => {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    const value = part.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
};

/**
 * The `Set-Cookie` value for a freshly issued session.
 *
 * `HttpOnly` so a script running on this origin (an XSS) cannot read the
 * token the way it could an API key sitting in `localStorage` — see
 * `web/src/api/key.ts` for the tradeoff that design accepted and this one
 * closes. `SameSite=Strict` means the browser never attaches this cookie to
 * a cross-site request AT ALL, which is what makes a separate CSRF token
 * unnecessary: there is no request for a hostile origin to ride the cookie
 * on. `Secure` is set only when the connection this cookie is issued over is
 * itself secure (`isSecureRequest`); a daemon reached over plain HTTP on a
 * LAN — the default, unproxied deployment — must still be able to set a
 * cookie its own browser will send back, which a `Secure` cookie over HTTP
 * never is.
 */
export const serializeSessionCookie = (input: { token: string; secure: boolean }): string => {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(input.token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}`,
  ];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
};

/** The `Set-Cookie` value that ends a session — same attributes, immediately expired. */
export const serializeClearedSessionCookie = (input: { secure: boolean }): string => {
  const attrs = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
};
