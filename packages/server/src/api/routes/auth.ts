import type { AccountRecord } from '../../db/account-repo.js';
import { DuplicateUsernameError } from '../../db/account-repo.js';
import { hashPassword, verifyPassword } from '../password.js';
import {
  SESSION_COOKIE_NAME,
  issueSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  verifySessionToken,
} from '../session.js';
import {
  OIDC_TRANSACTION_COOKIE,
  client,
  getOidcConfiguration,
  issueOidcTransactionToken,
  serializeClearedOidcTransactionCookie,
  serializeOidcTransactionCookie,
  verifyOidcTransactionToken,
} from '../oidc.js';
import {
  ApiError,
  ApiResponse,
  created,
  noContent,
  redirectTo,
  requireString,
  type ApiContext,
  type Route,
} from '../router.js';

/** What a caller is told about an account. Never the password hash. */
const toAccountResource = (account: AccountRecord) => ({
  id: account.id,
  username: account.username,
  displayName: account.displayName,
  loginMethod: account.oidcIssuer !== null ? ('oidc' as const) : ('password' as const),
  createdAt: account.createdAt,
  lastLoginAt: account.lastLoginAt,
});

/** Issues a fresh session cookie for `accountId` and records the login. */
const sessionCookieFor = async (input: {
  ctx: ApiContext;
  accountId: string;
  secure: boolean;
}): Promise<string> => {
  input.ctx.accounts.touchLastLogin(input.accountId, input.ctx.nowMs());
  const token = await issueSessionToken({
    accountId: input.accountId,
    secret: input.ctx.settings.getAuth().sessionSecret,
    nowMs: input.ctx.nowMs(),
  });
  return serializeSessionCookie({ token, secure: input.secure });
};

/**
 * Where the OIDC round trip returns the browser to. Only ever a same-origin
 * PATH — never an absolute URL a caller could hand in — because that value
 * is encoded into the transaction cookie before login happens, so it is
 * never validated against anything; an absolute URL here would turn this
 * endpoint into an open redirect usable against anyone who clicked a
 * crafted sign-in link.
 */
const sanitizeReturnTo = (raw: string | null): string => {
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
};

const invalidCredentials = (): never => {
  throw new ApiError(401, 'invalid-credentials', `That username or password was not accepted.`);
};

export const authRoutes: Route[] = [
  {
    method: 'GET',
    path: '/auth/status',
    // Anonymous: a browser has to know whether to show a login form, a
    // first-run setup form, or an SSO button before it has any way to
    // authenticate at all.
    anonymous: true,
    handler: ({ ctx }) => {
      const auth = ctx.settings.getAuth();
      return {
        setupRequired: ctx.accounts.count() === 0,
        oidc: auth.oidcEnabled ? { displayName: auth.oidcDisplayName } : null,
      };
    },
  },

  {
    method: 'GET',
    path: '/auth/session',
    // Anonymous, deliberately: this is the very question a freshly loaded
    // browser asks before it has any credential at all — "am I signed in?"
    // — and the answer to "no" is `{ account: null }`, not a 401. The
    // handler already never uses the API key for identity (only the
    // session cookie), so an API-key-only caller gets exactly the same
    // `{ account: null }` a plain anonymous caller does; nothing here
    // depends on the request having been pre-authorised.
    anonymous: true,
    handler: async ({ ctx, cookies }) => {
      // The API-key path has no account of its own; a machine client
      // asking "who am I" is told exactly that, rather than getting a 401
      // that would wrongly suggest the key itself was rejected.
      const token = cookies[SESSION_COOKIE_NAME];
      if (token === undefined) return { account: null };
      const accountId = await verifySessionToken({
        token,
        secret: ctx.settings.getAuth().sessionSecret,
      });
      const account = accountId === null ? null : ctx.accounts.getById(accountId);
      return { account: account === null ? null : toAccountResource(account) };
    },
  },

  {
    method: 'POST',
    path: '/auth/setup',
    anonymous: true,
    handler: async ({ body, ctx, secure }) => {
      // Only ever creates the FIRST account. Every account after that is
      // created through POST /auth/accounts by someone already signed in —
      // an anonymous endpoint that kept working after setup would let
      // anyone on the network mint themselves an account forever.
      if (ctx.accounts.count() > 0) {
        throw new ApiError(
          409,
          'setup-already-complete',
          `An account already exists. First-run setup only ever creates the first one; sign in ` +
            `and use POST /auth/accounts to add another.`,
        );
      }
      const username = requireString(body, 'username');
      const password = requireString(body, 'password');
      if (password.length < 8) {
        throw new ApiError(400, 'invalid-body', `"password" must be at least 8 characters.`);
      }
      const account = ctx.accounts.create({
        username,
        passwordHash: await hashPassword(password),
        nowMs: ctx.nowMs(),
      });
      const cookie = await sessionCookieFor({ ctx, accountId: account.id, secure });
      return new ApiResponse(201, toAccountResource(account), { 'set-cookie': cookie });
    },
  },

  {
    method: 'POST',
    path: '/auth/login',
    anonymous: true,
    handler: async ({ body, ctx, secure }) => {
      const username = requireString(body, 'username');
      const password = requireString(body, 'password');
      const account = ctx.accounts.getByUsername(username);
      const passwordHash = account?.passwordHash ?? null;
      if (passwordHash === null) {
        // Still hashes something, at the same cost, so a request against an
        // unknown (or OIDC-only) username does not return measurably
        // faster than one against a real password account — see
        // `api/auth.ts`'s `isAuthorised` for the same reasoning applied to
        // the API key.
        await verifyPassword({ password, hash: await hashPassword('unused-comparison-value') });
        invalidCredentials();
      }
      const ok = await verifyPassword({ password, hash: passwordHash! });
      if (!ok) invalidCredentials();
      // `invalidCredentials()` above never returns, so both `account` and
      // `passwordHash` being non-null is guaranteed by this point.
      const cookie = await sessionCookieFor({ ctx, accountId: account!.id, secure });
      return new ApiResponse(200, toAccountResource(account!), { 'set-cookie': cookie });
    },
  },

  {
    method: 'POST',
    path: '/auth/logout',
    // Anonymous: a browser whose cookie already expired must still be able
    // to ask for it to be cleared, rather than getting a 401 for the one
    // request whose entire job is ending a session that may already be
    // over.
    anonymous: true,
    handler: ({ secure }) =>
      new ApiResponse(204, null, { 'set-cookie': serializeClearedSessionCookie({ secure }) }),
  },

  {
    method: 'GET',
    path: '/auth/accounts',
    handler: ({ ctx }) => ({ accounts: ctx.accounts.list().map(toAccountResource) }),
  },

  {
    method: 'POST',
    path: '/auth/accounts',
    handler: async ({ body, ctx }) => {
      const username = requireString(body, 'username');
      const password = requireString(body, 'password');
      if (password.length < 8) {
        throw new ApiError(400, 'invalid-body', `"password" must be at least 8 characters.`);
      }
      try {
        const account = ctx.accounts.create({
          username,
          passwordHash: await hashPassword(password),
          nowMs: ctx.nowMs(),
        });
        return created(toAccountResource(account));
      } catch (error) {
        if (error instanceof DuplicateUsernameError) {
          throw new ApiError(409, 'duplicate-username', error.message);
        }
        throw error;
      }
    },
  },

  {
    method: 'DELETE',
    path: '/auth/accounts/:id',
    handler: ({ params, ctx }) => {
      // The one rule this endpoint enforces on its own: never let the last
      // account be removed. Every account has equal ("admin") access, so
      // there is no other account left to sign in and undo the mistake —
      // the daemon would still run, but nothing could ever reach it as a
      // browser again.
      if (ctx.accounts.count() <= 1) {
        throw new ApiError(
          409,
          'last-account',
          `This is the only account. Deleting it would lock every browser out of the daemon ` +
            `permanently — create another account first.`,
        );
      }
      const removed = ctx.accounts.remove(params.id!);
      if (!removed) {
        throw new ApiError(404, 'account-not-found', `No account with id "${params.id}".`);
      }
      return noContent();
    },
  },

  {
    method: 'PATCH',
    path: '/auth/accounts/:id/password',
    // Anonymous at the router, authorised in the handler: this endpoint's
    // rule is not "a valid credential" but "the account itself", and only
    // the session cookie names an account. An API key authorises a script
    // against the whole API without saying WHO is asking, so it cannot
    // satisfy this and is refused below rather than silently accepted.
    anonymous: true,
    handler: async ({ params, body, cookies, ctx }) => {
      const token = cookies[SESSION_COOKIE_NAME];
      const callerId =
        token === undefined
          ? null
          : await verifySessionToken({
              token,
              secret: ctx.settings.getAuth().sessionSecret,
            });

      // 403 rather than 401 for a caller who is signed in as someone else:
      // the credential was fine, the account was not, and re-authenticating
      // would not help. An unauthenticated caller gets the same answer
      // because from here the two are the same statement — this is not your
      // password to change.
      if (callerId === null || callerId !== params.id) {
        throw new ApiError(
          403,
          'not-your-account',
          `A password can only be changed by the account it belongs to, signed in as that ` +
            `account. To reset one nobody can sign in to, stop the daemon and use ` +
            `"trawlarr account set-password".`,
        );
      }

      const currentPassword = requireString(body, 'currentPassword');
      const newPassword = requireString(body, 'newPassword');
      if (newPassword.length < 8) {
        throw new ApiError(400, 'invalid-body', `"newPassword" must be at least 8 characters.`);
      }

      const account = ctx.accounts.getById(callerId);
      if (account === null) {
        throw new ApiError(404, 'account-not-found', `No account with id "${params.id}".`);
      }
      // An OIDC account's credential lives at the provider; there is no
      // local password to replace, and `passwordHash` is null rather than
      // empty precisely so this is a distinguishable case.
      if (account.passwordHash === null) {
        throw new ApiError(
          409,
          'not-a-password-account',
          `This account signs in through single sign-on, so its password is held by that ` +
            `provider and cannot be changed here.`,
        );
      }
      if (!(await verifyPassword({ password: currentPassword, hash: account.passwordHash }))) {
        // The same code and wording `POST /auth/login` uses for a bad
        // password, because it is the same statement about the same secret.
        throw new ApiError(400, 'invalid-credentials', `That password was not accepted.`);
      }

      ctx.accounts.setPassword(account.id, await hashPassword(newPassword));
      // NOTE: sessions already issued for this account STAY VALID — they
      // are stateless JWTs with no server-side store, so nothing here can
      // end them, and a stolen cookie outlives the password it was obtained
      // with by up to `SESSION_TTL_MS`. Tracked in #10.
      return noContent();
    },
  },

  {
    method: 'GET',
    path: '/auth/oidc/start',
    anonymous: true,
    handler: async ({ ctx, query, secure }) => {
      const auth = ctx.settings.getAuth();
      if (!auth.oidcEnabled) {
        throw new ApiError(404, 'oidc-disabled', `Single sign-on is not enabled on this daemon.`);
      }
      const config = await getOidcConfiguration(auth);
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();

      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: auth.oidcRedirectUri,
        scope: auth.oidcScopes,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });

      const txnToken = await issueOidcTransactionToken({
        state,
        nonce,
        codeVerifier,
        returnTo: sanitizeReturnTo(query.get('returnTo')),
        secret: auth.sessionSecret,
        nowMs: ctx.nowMs(),
      });

      return redirectTo(authorizationUrl.href, {
        'set-cookie': serializeOidcTransactionCookie({ token: txnToken, secure }),
      });
    },
  },

  {
    method: 'GET',
    path: '/auth/oidc/callback',
    anonymous: true,
    handler: async ({ ctx, cookies, query, secure }) => {
      const auth = ctx.settings.getAuth();
      if (!auth.oidcEnabled) {
        throw new ApiError(404, 'oidc-disabled', `Single sign-on is not enabled on this daemon.`);
      }
      const txnToken = cookies[OIDC_TRANSACTION_COOKIE];
      const txn =
        txnToken === undefined
          ? null
          : await verifyOidcTransactionToken({ token: txnToken, secret: auth.sessionSecret });
      // Cleared unconditionally, success or failure: a transaction cookie
      // is single-use, so nothing about a retry should ever see it again.
      const clearedTxnCookie = serializeClearedOidcTransactionCookie({ secure });
      if (txn === null) {
        throw new ApiError(
          400,
          'oidc-transaction-expired',
          `This sign-in attempt has expired, was already used, or arrived without its cookie. ` +
            `Start again from the login page.`,
        );
      }

      const config = await getOidcConfiguration(auth);
      const currentUrl = new URL(auth.oidcRedirectUri);
      currentUrl.search = query.toString();

      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: txn.codeVerifier,
        expectedState: txn.state,
        expectedNonce: txn.nonce,
      });
      const claims = tokens.claims();
      if (claims === undefined || typeof claims.sub !== 'string') {
        throw new ApiError(502, 'oidc-no-subject', `The provider's ID token had no "sub" claim.`);
      }
      const issuer = config.serverMetadata().issuer;

      let account = ctx.accounts.getByOidcIdentity({ issuer, subject: claims.sub });
      if (account === null) {
        const displayName =
          (typeof claims.name === 'string' ? claims.name : undefined) ??
          (typeof claims.email === 'string' ? claims.email : undefined) ??
          null;
        account = ctx.accounts.createFromOidc({
          oidcIssuer: issuer,
          oidcSubject: claims.sub,
          displayName,
          nowMs: ctx.nowMs(),
        });
      }

      const sessionCookie = await sessionCookieFor({ ctx, accountId: account.id, secure });
      return redirectTo(txn.returnTo, { 'set-cookie': [sessionCookie, clearedTxnCookie] });
    },
  },
];
