import { describe, expect, it } from 'vitest';
import {
  flowLabel,
  formatWindow,
  oidcSummary,
  parseWindow,
  parseWorkerCount,
  summarizePurge,
  validatePasswordChange,
  toFlowNames,
  validateOidcDraft,
  type PublicAuthSettings,
  type PurgeSweep,
} from './config-model.js';

const DISABLED_AUTH: PublicAuthSettings = {
  oidcEnabled: false,
  oidcIssuer: '',
  oidcClientId: '',
  oidcClientSecret: '',
  oidcRedirectUri: '',
  oidcScopes: 'openid profile email',
  oidcDisplayName: 'Single Sign-On',
};

describe('validateOidcDraft', () => {
  it('allows OIDC to stay off with every field blank', () => {
    expect(validateOidcDraft(DISABLED_AUTH)).toBeNull();
  });

  it('allows enabling once every required field is filled in', () => {
    expect(
      validateOidcDraft({
        ...DISABLED_AUTH,
        oidcEnabled: true,
        oidcIssuer: 'https://authentik.example.com/application/o/trawlarr/',
        oidcClientId: 'trawlarr',
        oidcClientSecret: 'shh',
        oidcRedirectUri: 'https://trawlarr.example.com/auth/oidc/callback',
      }),
    ).toBeNull();
  });

  it('names the first missing field rather than a generic complaint', () => {
    expect(validateOidcDraft({ ...DISABLED_AUTH, oidcEnabled: true })).toContain('issuer URL');
    expect(
      validateOidcDraft({
        ...DISABLED_AUTH,
        oidcEnabled: true,
        oidcIssuer: 'https://authentik.example.com/application/o/trawlarr/',
      }),
    ).toContain('client ID');
  });

  it('treats a whitespace-only field the same as an empty one', () => {
    expect(
      validateOidcDraft({
        ...DISABLED_AUTH,
        oidcEnabled: true,
        oidcIssuer: '   ',
        oidcClientId: 'trawlarr',
        oidcClientSecret: 'shh',
        oidcRedirectUri: 'https://trawlarr.example.com/auth/oidc/callback',
      }),
    ).toContain('issuer URL');
  });
});

describe('parseWorkerCount', () => {
  it('accepts zero, which is how work is stopped', () => {
    expect(parseWorkerCount('0')).toEqual({ ok: true, value: 0 });
  });

  it('refuses a negative or fractional count', () => {
    expect(parseWorkerCount('-1').ok).toBe(false);
    expect(parseWorkerCount('1.5').ok).toBe(false);
  });

  it('refuses an empty box, which is not a request for zero workers', () => {
    // `Number('')` is 0 and `Number.isInteger(0)` is true, so a cleared
    // field used to parse clean and Save wrote 0 — stopping every transcode
    // while the operator looked at an empty box.
    expect(parseWorkerCount('')).toEqual({
      ok: false,
      message: 'Enter a number of workers. An empty box is not zero.',
    });
    expect(parseWorkerCount('   ')).toEqual({
      ok: false,
      message: 'Enter a number of workers. An empty box is not zero.',
    });
  });

  it('refuses the forms `Number` would happily accept but nobody types', () => {
    // `Number('0x10')` is 16 and `Number('1e3')` is 1000 — a count that does
    // not look like what is on screen is worse than a rejected one.
    expect(parseWorkerCount('0x10').ok).toBe(false);
    expect(parseWorkerCount('1e3').ok).toBe(false);
    expect(parseWorkerCount('+5').ok).toBe(false);
    expect(parseWorkerCount('Infinity').ok).toBe(false);
  });

  it('refuses text', () => {
    expect(parseWorkerCount('lots')).toEqual({
      ok: false,
      message: 'Enter a whole number of workers.',
    });
  });
});

describe('parseWindow', () => {
  it('reads HH:MM as minutes past midnight', () => {
    expect(parseWindow('02:30')).toEqual({ ok: true, minutes: 150 });
    expect(parseWindow('00:00')).toEqual({ ok: true, minutes: 0 });
  });

  it('refuses an impossible clock time', () => {
    expect(parseWindow('25:00').ok).toBe(false);
    expect(parseWindow('02:60').ok).toBe(false);
  });

  it('round-trips through formatWindow', () => {
    expect(formatWindow(150)).toBe('02:30');
    expect(formatWindow(0)).toBe('00:00');
  });
});

describe('summarizePurge', () => {
  const sweep = (patch: Partial<PurgeSweep> = {}): PurgeSweep => ({
    libraryId: 'lib-1',
    libraryName: 'Movies',
    retentionDays: 14,
    dryRun: true,
    summary: {
      dirsSwept: 1,
      dirsMissing: 0,
      dirsRefused: 0,
      removed: 3,
      bytesFreed: 1_000,
      retained: 1,
      skipped: 0,
      failed: 0,
    },
    ...patch,
  });

  it('sums removed files and bytes freed across every library swept', () => {
    expect(
      summarizePurge([
        sweep({ summary: { ...sweep().summary, removed: 3, bytesFreed: 1_000 } }),
        sweep({
          libraryId: 'lib-2',
          summary: { ...sweep().summary, removed: 2, bytesFreed: 500 },
        }),
      ]),
    ).toEqual({ files: 5, bytes: 1_500, failed: 0 });
  });

  it('reports files this run could not remove, so a partial purge is never silent', () => {
    expect(summarizePurge([sweep({ summary: { ...sweep().summary, failed: 2 } })])).toEqual({
      files: 3,
      bytes: 1_000,
      failed: 2,
    });
  });

  it('is zero for an empty sweep list', () => {
    expect(summarizePurge([])).toEqual({ files: 0, bytes: 0, failed: 0 });
  });
});

describe('toFlowNames', () => {
  it('indexes the flow listing by id', () => {
    expect(
      toFlowNames([
        { id: 'f1', name: 'Transcode to HEVC' },
        { id: 'f2', name: 'Conform library' },
      ]),
    ).toEqual({ f1: 'Transcode to HEVC', f2: 'Conform library' });
  });

  it('is empty for an empty listing rather than undefined', () => {
    expect(toFlowNames([])).toEqual({});
  });
});

describe('flowLabel', () => {
  it('prefers the name, which is the whole reason the lookup exists', () => {
    expect(flowLabel('f1', { f1: 'Transcode to HEVC' })).toBe('Transcode to HEVC');
  });

  /**
   * The names arrive from a second request, deliberately separate so that a
   * failed flow listing cannot blank the libraries list. Every card therefore
   * renders at least once before they land — and forever without them if that
   * request failed, or if the flow has since been deleted.
   *
   * The id is not a nice label, but it identifies a real flow and it is what
   * the API and the CLI both speak. Printing "undefined" there would be worse
   * than the uuid this whole lookup replaced.
   */
  it('falls back to the id, never to "undefined"', () => {
    expect(flowLabel('f1', {})).toBe('f1');
    expect(flowLabel('f1', { f2: 'Some other flow' })).toBe('f1');
    expect(flowLabel('f1', { f1: '' })).toBe('f1');
  });

  it('never returns an empty string, whatever the map holds', () => {
    const cases: Array<Record<string, string>> = [{}, { f1: '' }, { f1: 'Named' }];
    for (const names of cases) {
      expect(flowLabel('f1', names)).not.toBe('');
    }
  });
});

describe('oidcSummary', () => {
  /**
   * The section hides its fields when SSO is off, which risks a worse
   * problem than the clutter it fixes: someone who configured SSO, turned it
   * off, and came back would see an empty section and conclude their
   * settings were lost. Disabling keeps them — so the collapsed state says
   * so, rather than looking identical to never-configured.
   */
  it('says settings survive being switched off', () => {
    expect(
      oidcSummary({
        ...DISABLED_AUTH,
        oidcIssuer: 'https://authentik.example.com/application/o/trawlarr/',
      }),
    ).toBe(
      'Settings are saved for https://authentik.example.com/application/o/trawlarr/, but single sign-on is off.',
    );
  });

  /**
   * Silence, not "nothing is saved". The overwhelmingly common install has
   * never touched SSO, and a line reporting the absence of something nobody
   * configured is noise on every one of them.
   */
  it('says nothing at all when nothing was ever configured', () => {
    expect(oidcSummary(DISABLED_AUTH)).toBeNull();
    expect(oidcSummary({ ...DISABLED_AUTH, oidcIssuer: '   ' })).toBeNull();
  });

  // While it is on, the fields are on screen and speak for themselves.
  it('says nothing while single sign-on is enabled', () => {
    expect(
      oidcSummary({
        ...DISABLED_AUTH,
        oidcEnabled: true,
        oidcIssuer: 'https://authentik.example.com/application/o/trawlarr/',
      }),
    ).toBeNull();
  });
});

describe('validatePasswordChange', () => {
  const draft = {
    currentPassword: 'the-old-password',
    newPassword: 'a-brand-new-secret',
    confirmPassword: 'a-brand-new-secret',
  };

  it('accepts a change that satisfies every rule', () => {
    expect(validatePasswordChange(draft)).toBeNull();
  });

  /**
   * Caught here rather than by the API, which cannot see it: the two boxes
   * are masked, so a typo in the second is invisible, and the server is only
   * ever sent one of them. Getting this wrong means setting a password
   * nobody knows.
   */
  it('refuses when the confirmation does not match', () => {
    expect(validatePasswordChange({ ...draft, confirmPassword: 'a-brand-new-secrft' })).toContain(
      'do not match',
    );
  });

  // The same floor the API and the CLI apply, said before a round trip
  // rather than after one.
  it('refuses a new password under eight characters', () => {
    expect(
      validatePasswordChange({ ...draft, newPassword: 'short', confirmPassword: 'short' }),
    ).toContain('8 characters');
  });

  it('asks for the current password rather than sending a blank one', () => {
    expect(validatePasswordChange({ ...draft, currentPassword: '' })).toContain('current password');
    expect(validatePasswordChange({ ...draft, currentPassword: '   ' })).toContain(
      'current password',
    );
  });

  // A no-op the server would accept and the operator would misread as
  // "changed", so it is refused where the difference is still visible.
  it('refuses a new password identical to the current one', () => {
    expect(
      validatePasswordChange({
        currentPassword: 'the-old-password',
        newPassword: 'the-old-password',
        confirmPassword: 'the-old-password',
      }),
    ).toContain('already');
  });
});
