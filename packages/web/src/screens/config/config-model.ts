/**
 * Form values for the Configure screen, parsed once and in one place.
 *
 * The schedule API speaks MINUTES PAST MIDNIGHT and the control speaks
 * `HH:MM`; getting that wrong silently sets a window nobody asked for, which
 * has already happened once by hand — see `parseWindow`/`formatWindow`.
 *
 * `Config.tsx` is deliberately untested (there is no DOM testing library in
 * this repo), so every branch worth asserting lives here instead, where
 * `config-model.test.ts` can reach it with no DOM at all.
 */

/**
 * `@trawlarr/core`'s own `WorkerClass`/`WORKER_CLASSES` — this package
 * depends on `@trawlarr/core` now, so re-exporting these rather than keeping
 * a second, hand-written copy is what avoids the two definitions drifting
 * apart. (`api/events.ts` still keeps its own copy, for the reason its own
 * comment gives.)
 *
 * Imported from the `./worker-class` SUBPATH, the same way
 * `FlowCompare.tsx` reaches `diffFlowDefinitions` through `./flow-diff`
 * rather than the bare `@trawlarr/core` — `@trawlarr/core`'s root barrel
 * (`index.ts`) re-exports `canonical-json.ts`, which imports `node:crypto`,
 * and Vite's browser build has no stub for that (see `vite.config.ts`'s own
 * comment on why it avoids adding one more dependency to work around it).
 * A bare `@trawlarr/core` import for a *type* is fine — the type is erased
 * before bundling ever sees it — but a VALUE import of anything through the
 * root barrel drags that whole module graph, `node:crypto` included, into
 * the bundle and fails the build. The subpath sidesteps the barrel
 * entirely.
 */
export type { WorkerClass } from '@trawlarr/core/worker-class';
export { WORKER_CLASSES } from '@trawlarr/core/worker-class';

/**
 * A worker count, from the box the operator typed it into.
 *
 * AN EMPTY BOX IS NOT ZERO. `Number('')` is `0` and `Number.isInteger(0)` is
 * true, so a cleared field used to parse as a valid `{ ok: true, value: 0 }`:
 * no validation error, nothing marked invalid, and Save wrote 0 — stopping
 * every transcode — while the operator looked at an empty box rather than at
 * a `0`. On the one control that is both this system's start button and its
 * runaway stop button, "I cleared the field" and "I asked for zero workers"
 * must not be the same request.
 *
 * The digits-only test is deliberate, and stricter than `Number.isInteger`
 * on `Number(raw)`: `Number` also accepts `'0x10'` (16), `'1e3'` (1000),
 * `'  7 '`, `'Infinity'` and `'+5'`. None of those is a number of workers
 * anyone means to type, and each would silently set a count that does not
 * look like what is on screen. `'0'` still parses — zero is how work is
 * stopped, and that has to stay sayable.
 */
export const parseWorkerCount = (
  raw: string,
): { ok: true; value: number } | { ok: false; message: string } => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, message: 'Enter a number of workers. An empty box is not zero.' };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: 'Enter a whole number of workers.' };
  }
  return { ok: true, value: Number(trimmed) };
};

export const parseWindow = (
  raw: string,
): { ok: true; minutes: number } | { ok: false; message: string } => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (match === null) return { ok: false, message: 'Use HH:MM, for example 02:30.' };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false, message: 'That is not a time of day.' };
  return { ok: true, minutes: hours * 60 + minutes };
};

export const formatWindow = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

/**
 * One library's result from `POST /system/maintenance/trash-purge`, exactly
 * as the daemon reports it (`LibraryTrashSweep` in
 * `packages/server/src/library/trash-sweep.ts`) — declared structurally here
 * so a field neither this screen nor the test reads can be added on the
 * server without breaking this type.
 */
export interface PurgeSweep {
  libraryId: string;
  libraryName: string;
  retentionDays: number;
  dryRun: boolean;
  summary: {
    dirsSwept: number;
    dirsMissing: number;
    dirsRefused: number;
    removed: number;
    bytesFreed: number;
    retained: number;
    skipped: number;
    failed: number;
  };
}

/**
 * What a purge (real or a `dryRun` preview of one) did, or would do, across
 * every library it touched — the number the confirmation dialog and the
 * "purge finished" message both read from, so the two can never disagree
 * about how much was deleted.
 *
 * `failed` is carried through rather than folded into `files`: trash purge is
 * irreversible, so a run that removed 5 of 7 candidates has to say so rather
 * than quietly reporting "5 removed" as if that were the whole job.
 */
export const summarizePurge = (
  sweeps: PurgeSweep[],
): { files: number; bytes: number; failed: number } =>
  sweeps.reduce(
    (total, sweep) => ({
      files: total.files + sweep.summary.removed,
      bytes: total.bytes + sweep.summary.bytesFreed,
      failed: total.failed + sweep.summary.failed,
    }),
    { files: 0, bytes: 0, failed: 0 },
  );

/**
 * Flow id → flow name, from `GET /flows`.
 *
 * A library resource carries only `flowId`, and the Libraries tab printed
 * that uuid on the card — the one line an operator most needs to recognise,
 * rendered as the one thing nobody can. This is the lookup that fixes it.
 */
export const toFlowNames = (flows: Array<{ id: string; name: string }>): Record<string, string> =>
  Object.fromEntries(flows.map((flow) => [flow.id, flow.name]));

/**
 * What to print for a library's attached flow.
 *
 * THE FALLBACK IS THE POINT. The name comes from a SECOND request, made
 * separately so a flow-listing blip cannot blank the libraries list — which
 * means every caller renders at least once before the names arrive, and will
 * render forever without them if that request failed or if the flow has since
 * been deleted. Returning the id in that window keeps the card identifying a
 * real flow; reading a missing key straight out of the map would print
 * "undefined" on the card instead.
 */
export const flowLabel = (flowId: string, names: Record<string, string>): string => {
  const name = names[flowId];
  return name === undefined || name === '' ? flowId : name;
};

/**
 * `GET /system/settings`'s `auth` field, exactly as `routes/system.ts`
 * reports it — `sessionSecret` is never included in that response (see its
 * own comment there), so it has no place in this type either.
 */
export interface PublicAuthSettings {
  oidcEnabled: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  oidcScopes: string;
  oidcDisplayName: string;
}

/**
 * The same "every field required once enabled" rule `settings-repo.ts`'s
 * `validateAuth` enforces server-side, checked here first so flipping the
 * toggle with blank fields fails on the spot with a message naming exactly
 * what is missing, rather than round-tripping to the API to learn the same
 * thing a beat later.
 */
export const validateOidcDraft = (draft: PublicAuthSettings): string | null => {
  if (!draft.oidcEnabled) return null;
  if (draft.oidcIssuer.trim() === '') return 'Set an issuer URL before enabling single sign-on.';
  if (draft.oidcClientId.trim() === '') return 'Set a client ID before enabling single sign-on.';
  if (draft.oidcClientSecret.trim() === '')
    return 'Set a client secret before enabling single sign-on.';
  if (draft.oidcRedirectUri.trim() === '')
    return 'Set a redirect URI before enabling single sign-on.';
  return null;
};

/**
 * What to say about stored SSO settings while the section is collapsed.
 *
 * The fields are hidden when single sign-on is off, which risks a worse
 * problem than the clutter it fixes: an operator who configured SSO, turned
 * it off, and came back later would see an empty section and conclude their
 * settings were gone. They are not — disabling keeps them, so that
 * re-enabling does not mean re-typing a client secret.
 *
 * `null` when there is genuinely nothing stored, so a daemon that has never
 * had SSO configured says nothing at all rather than "nothing is saved",
 * which is noise on the overwhelmingly common install.
 *
 * The issuer is printed whole rather than reduced to a host: it is the field
 * an operator compares against their provider, and parsing it here would
 * mean deciding what to do with a value the provider has not accepted yet.
 */
export const oidcSummary = (settings: PublicAuthSettings): string | null => {
  if (settings.oidcEnabled) return null;
  const issuer = settings.oidcIssuer.trim();
  if (issuer === '') return null;
  return `Settings are saved for ${issuer}, but single sign-on is off.`;
};

export interface PasswordChangeDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * Everything wrong with a password change that can be seen without asking
 * the daemon, in the order an operator filling the form in would hit it.
 *
 * The confirmation check is the one the API CANNOT make on its own: both
 * boxes are masked, a typo in the second is invisible, and only one of them
 * is ever sent. Getting it wrong sets a password nobody knows — on the one
 * screen where that is expensive, since the account it belongs to is the one
 * you are signed in as.
 *
 * The length floor is the same 8 the endpoint and the CLI enforce. Repeating
 * it here is not the check that matters — the server's is — it just says so
 * before a round trip instead of after one.
 */
export const validatePasswordChange = (draft: PasswordChangeDraft): string | null => {
  if (draft.currentPassword.trim() === '') return 'Enter your current password.';
  if (draft.newPassword.length < 8) return 'A new password must be at least 8 characters.';
  if (draft.newPassword !== draft.confirmPassword) return 'Those two passwords do not match.';
  // A change to the same value round-trips, succeeds, and reads as "done" —
  // leaving someone who meant to rotate a leaked password believing they
  // had. Refused where the difference is still on screen.
  if (draft.newPassword === draft.currentPassword) return 'That is already your password.';
  return null;
};
