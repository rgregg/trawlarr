import { useCallback, useEffect, useState } from 'react';
import { createApiClient, type ApiClient } from '../api/client.js';
import {
  createFirstAccount,
  fetchAuthStatus,
  fetchSession,
  login as loginRequest,
  logout as logoutRequest,
  type AccountResource,
  type AuthStatus,
} from '../api/session.js';
import { guardClient } from './auth-guard.js';

export interface AuthState {
  /** Undefined while the initial `/auth/status` + `/auth/session` round trip is in flight. */
  status: AuthStatus | undefined;
  /** The signed-in account, or null once it is known there is none. */
  account: AccountResource | null | undefined;
  client: ApiClient | null;
  error: string | null;
  setup: (input: { username: string; password: string }) => Promise<void>;
  login: (input: { username: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * The account, the client built once it exists, and the three ways to get
 * one: first-run setup, username/password, or (outside this hook) the OIDC
 * redirect, which lands back here as an ordinary session cookie the next
 * `/auth/session` call picks up.
 *
 * A ROTATED OR EXPIRED SESSION MUST BE RECOVERABLE FROM THE UI, same
 * requirement the old key-based `useApi` held for a rotated key: every call
 * through the returned client is wrapped so a 401 clears `account`, which
 * drops the app back to the login screen instead of leaving it stuck
 * rendering against a session the daemon no longer honours.
 */
export const useAuth = (): AuthState => {
  const [status, setStatus] = useState<AuthStatus | undefined>(undefined);
  const [account, setAccount] = useState<AccountResource | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [nextStatus, nextAccount] = await Promise.all([fetchAuthStatus(), fetchSession()]);
      if (cancelled) return;
      setStatus(nextStatus);
      setAccount(nextAccount);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await logoutRequest();
    setAccount(null);
  }, []);

  const client =
    account === null || account === undefined ? null : guardClient(createApiClient({}), signOut);

  const runAuthAction = useCallback(
    (action: (input: { username: string; password: string }) => Promise<AccountResource>) =>
      async (input: { username: string; password: string }): Promise<void> => {
        setError(null);
        try {
          const created = await action(input);
          setAccount(created);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'That did not work.');
          throw caught;
        }
      },
    [],
  );

  return {
    status,
    account,
    client,
    error,
    setup: runAuthAction(createFirstAccount),
    login: runAuthAction(loginRequest),
    signOut,
  };
};
