import { createApiClient } from './client.js';

export interface AccountResource {
  id: string;
  username: string | null;
  displayName: string | null;
  loginMethod: 'password' | 'oidc';
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AuthStatus {
  /** True until the very first account has been created on this daemon. */
  setupRequired: boolean;
  /** Null when single sign-on is not configured; otherwise its button label. */
  oidc: { displayName: string } | null;
}

const client = (baseUrl?: string) => createApiClient({ baseUrl });

/**
 * What the login screen needs to know BEFORE anyone has signed in: whether
 * to show first-run setup, a login form, an SSO button, or some combination.
 * Anonymous on the daemon, so it works with no credential at all.
 */
export const fetchAuthStatus = async (baseUrl?: string): Promise<AuthStatus> =>
  await client(baseUrl).get<AuthStatus>('/auth/status');

/**
 * Who — if anyone — the current browser is signed in as. `null` covers both
 * "there is no session cookie" and "the API key has no account of its own";
 * neither is an error the caller should throw on, so this never rejects for
 * either case (only for a genuine network/server failure).
 */
export const fetchSession = async (baseUrl?: string): Promise<AccountResource | null> => {
  const result = await client(baseUrl).get<{ account: AccountResource | null }>('/auth/session');
  return result.account;
};

export const createFirstAccount = async (
  input: { username: string; password: string },
  baseUrl?: string,
): Promise<AccountResource> => await client(baseUrl).post<AccountResource>('/auth/setup', input);

export const login = async (
  input: { username: string; password: string },
  baseUrl?: string,
): Promise<AccountResource> => await client(baseUrl).post<AccountResource>('/auth/login', input);

export const logout = async (baseUrl?: string): Promise<void> => {
  await client(baseUrl).post('/auth/logout');
};

/** Where the SSO button sends the browser; `returnTo` must be a same-origin path. */
export const oidcStartUrl = (input: { returnTo: string; baseUrl?: string }): string => {
  const base = input.baseUrl ?? '';
  return `${base}/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(input.returnTo)}`;
};
