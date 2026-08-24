import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { normalizeLanguageTag, normalizeProbeLanguages } from './language-tag.js';

describe('normalizeLanguageTag', () => {
  it('canonicalises the spellings the owner’s library actually contains', () => {
    // These two literal strings are what six Ally McBeal files carry instead
    // of `eng`. Everything else in this suite generalises from them.
    expect(normalizeLanguageTag('english')).toBe('eng');
    expect(normalizeLanguageTag('English')).toBe('eng');
  });

  it('accepts ISO 639-1 alpha-2 codes, which no exact-match plugin can use', () => {
    expect(normalizeLanguageTag('en')).toBe('eng');
    expect(normalizeLanguageTag('ja')).toBe('jpn');
    expect(normalizeLanguageTag('sv')).toBe('swe');
  });

  it('folds ISO 639-2/T onto 639-2/B, which is the form media tooling uses', () => {
    // The pairs that actually differ. Tdarr's own henk plugin converts to
    // alpha3B for the same reason.
    expect(normalizeLanguageTag('deu')).toBe('ger');
    expect(normalizeLanguageTag('fra')).toBe('fre');
    expect(normalizeLanguageTag('ces')).toBe('cze');
    expect(normalizeLanguageTag('zho')).toBe('chi');
  });

  it('is indifferent to case and surrounding whitespace', () => {
    expect(normalizeLanguageTag('ENG')).toBe('eng');
    expect(normalizeLanguageTag(' Eng ')).toBe('eng');
    expect(normalizeLanguageTag('\tGERMAN\n')).toBe('ger');
    expect(normalizeLanguageTag('Fra')).toBe('fre');
  });

  it('drops a BCP-47 region or script subtag rather than failing to recognise the language', () => {
    expect(normalizeLanguageTag('en-US')).toBe('eng');
    expect(normalizeLanguageTag('en_GB')).toBe('eng');
    expect(normalizeLanguageTag('pt-BR')).toBe('por');
    expect(normalizeLanguageTag('zh-Hans')).toBe('chi');
  });

  it('leaves a tag that is already canonical exactly as it is', () => {
    for (const tag of ['eng', 'jpn', 'kor', 'ger', 'fre', 'spa']) {
      expect(normalizeLanguageTag(tag)).toBe(tag);
    }
  });

  it('never turns "no language" into a language', () => {
    // `und` is the ISO code for "undetermined" and is a deliberate statement
    // about the track; `mis`, `mul` and `zxx` likewise. Mapping any of them to
    // a real language would make a keep-list delete audio nobody classified.
    expect(normalizeLanguageTag('und')).toBe('und');
    expect(normalizeLanguageTag('mis')).toBe('mis');
    expect(normalizeLanguageTag('mul')).toBe('mul');
    expect(normalizeLanguageTag('zxx')).toBe('zxx');
    expect(normalizeLanguageTag('')).toBe('');
    expect(normalizeLanguageTag('   ')).toBe('   ');
  });

  it('returns anything it does not confidently recognise byte for byte', () => {
    // A wrong normalisation silently deletes the wrong audio track, so the
    // table refuses to guess: endonyms, dialect names outside the table, and
    // free-text descriptions all pass through untouched.
    for (const tag of [
      'Deutsch',
      'español',
      'français',
      'Brazilian Portuguese',
      'yue',
      'cantonese',
      'nb',
      'commentary',
      'Director’s Commentary',
      'qaa',
      '???',
      'engg',
    ]) {
      expect(normalizeLanguageTag(tag)).toBe(tag);
    }
  });

  it('is idempotent, which is what stops a rescan from seeing a new value', () => {
    for (const tag of ['English', 'en-US', 'deu', 'und', 'Deutsch', '']) {
      const once = normalizeLanguageTag(tag);
      expect(normalizeLanguageTag(once)).toBe(once);
    }
  });
});

describe('normalizeProbeLanguages', () => {
  const probeWith = (languages: (string | undefined)[]): ProbeData => ({
    format: { duration: '60.0' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      ...languages.map((language, i) => ({
        index: i + 1,
        codec_type: 'audio',
        codec_name: 'aac',
        ...(language === undefined ? {} : { tags: { language } }),
      })),
    ],
  });

  it('rewrites recognised tags and leaves everything else alone', () => {
    const out = normalizeProbeLanguages(probeWith(['English', 'spa', 'und', 'Deutsch', undefined]));
    expect((out.streams ?? []).map((s) => s.tags?.language)).toEqual([
      undefined,
      'eng',
      'spa',
      'und',
      'Deutsch',
      undefined,
    ]);
  });

  it('preserves every other tag on a stream it rewrites', () => {
    const probe: ProbeData = {
      streams: [
        {
          index: 0,
          codec_type: 'audio',
          codec_name: 'aac',
          tags: { language: 'English', title: 'Commentary', BPS: '128000' },
        },
      ],
    };
    expect(normalizeProbeLanguages(probe).streams?.[0]?.tags).toEqual({
      language: 'eng',
      title: 'Commentary',
      BPS: '128000',
    });
  });

  it('does not mutate the probe it was given — the raw probe stays raw', () => {
    // The stored probe, the facts convergence is judged on, and verifyOutput's
    // before/after comparison all read the ORIGINAL object.
    const probe = probeWith(['English']);
    normalizeProbeLanguages(probe);
    expect(probe.streams?.[1]?.tags?.language).toBe('English');
  });

  it('returns the same object when there is nothing to change', () => {
    const probe = probeWith(['eng', 'und', undefined]);
    expect(normalizeProbeLanguages(probe)).toBe(probe);
  });

  it('survives a probe with no streams at all', () => {
    const probe: ProbeData = { format: {} };
    expect(normalizeProbeLanguages(probe)).toBe(probe);
  });
});
