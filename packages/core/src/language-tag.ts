import type { ProbeData, ProbeStream } from '@trawlarr/plugin-api';

/**
 * Language tags in real libraries are not all ISO codes.
 *
 * Every language-aware plugin in the Tdarr corpus compares
 * `stream.tags.language` against a user-supplied list of ISO 639-2 codes, and
 * none of them normalises first:
 *
 *  - `FlowPlugins/.../ffmpegCommandRemoveStreamByProperty/1.0.0` lowercases the
 *    tag and then does `prop.includes(val)` / `prop === val`;
 *  - `Community/Tdarr_Plugin_MC93_Migz3CleanAudio.js:136` does
 *    `language.indexOf(tags.language.toLowerCase()) === -1` — an EXACT match,
 *    so a track tagged `English` under a `eng` keep-list is removed;
 *  - `Community/Tdarr_Plugin_e5c3_CnT_Keep_Preferred_Audio.js:22` and a dozen
 *    others simply tell the user "language format has to be according to the
 *    iso-639-2 standard".
 *
 * That is fine while every file is tagged the way the plugin assumes, and it
 * silently deletes the wrong audio track when one is not. The owner's library
 * contains files whose audio carries the literal strings `english` / `English`,
 * and files carrying 639-1 `en`; both fail an exact match against `eng`, and
 * `en` fails the substring test too.
 *
 * Tdarr's own answer, where it has one, is to normalise the OTHER side:
 * `Community/Tdarr_Plugin_henk_Keep_Native_Lang_Plus_Eng.js:134` converts the
 * language it learns from TMDB/Radarr with
 * `require('@cospired/i18n-iso-languages').alpha2ToAlpha3B(...)` before
 * comparing. Two things are taken from that precedent: the canonical form is
 * ISO 639-2/**B** (the bibliographic codes — `ger`, `fre`, not `deu`, `fra`),
 * and 639-1 alpha-2 is a form worth converting rather than rejecting.
 *
 * What is deliberately NOT taken from it is the direction. Trawlarr normalises
 * the tag it reads from the file, at the host boundary, because the comparison
 * itself lives inside vendored third-party plugin code this project runs as-is.
 *
 * ## The safety rule
 *
 * A tag this table does not recognise is returned BYTE-FOR-BYTE UNCHANGED. A
 * wrong normalisation deletes the wrong audio track, which is strictly worse
 * than no normalisation at all, so the table only contains mappings that are
 * unambiguous. In particular `und` (undetermined), `mis`, `mul`, `zxx` and the
 * empty string are meaningful as themselves and appear nowhere in it.
 */

/**
 * `[639-2/B, 639-2/T or '', 639-1 or '', ...English names]`.
 *
 * Scope: the languages that actually appear in commercially distributed media
 * — the dubbing and subtitling markets, plus the owner's library. This is NOT
 * the full ISO 639 register (~7 000 entries) and is not meant to become it:
 * every row is a claim that must be right, and an unrecognised tag already has
 * a safe answer. Adding a row is cheap; getting one wrong is not.
 */
const LANGUAGES: readonly (readonly string[])[] = [
  ['eng', '', 'en', 'english'],
  ['spa', '', 'es', 'spanish', 'castilian'],
  ['fre', 'fra', 'fr', 'french'],
  ['ger', 'deu', 'de', 'german'],
  ['ita', '', 'it', 'italian'],
  ['por', '', 'pt', 'portuguese'],
  ['dut', 'nld', 'nl', 'dutch'],
  ['swe', '', 'sv', 'swedish'],
  ['nor', '', 'no', 'norwegian'],
  ['dan', '', 'da', 'danish'],
  ['fin', '', 'fi', 'finnish'],
  ['ice', 'isl', 'is', 'icelandic'],
  ['rus', '', 'ru', 'russian'],
  ['pol', '', 'pl', 'polish'],
  ['cze', 'ces', 'cs', 'czech'],
  ['slo', 'slk', 'sk', 'slovak'],
  ['hun', '', 'hu', 'hungarian'],
  ['rum', 'ron', 'ro', 'romanian'],
  ['bul', '', 'bg', 'bulgarian'],
  ['gre', 'ell', 'el', 'greek'],
  ['tur', '', 'tr', 'turkish'],
  ['ukr', '', 'uk', 'ukrainian'],
  ['hrv', '', 'hr', 'croatian'],
  ['srp', '', 'sr', 'serbian'],
  ['slv', '', 'sl', 'slovenian'],
  ['bos', '', 'bs', 'bosnian'],
  ['mac', 'mkd', 'mk', 'macedonian'],
  ['alb', 'sqi', 'sq', 'albanian'],
  ['est', '', 'et', 'estonian'],
  ['lav', '', 'lv', 'latvian'],
  ['lit', '', 'lt', 'lithuanian'],
  ['cat', '', 'ca', 'catalan'],
  ['baq', 'eus', 'eu', 'basque'],
  ['glg', '', 'gl', 'galician'],
  ['wel', 'cym', 'cy', 'welsh'],
  ['gle', '', 'ga', 'irish'],
  ['heb', '', 'he', 'hebrew'],
  ['ara', '', 'ar', 'arabic'],
  ['per', 'fas', 'fa', 'persian', 'farsi'],
  ['hin', '', 'hi', 'hindi'],
  ['ben', '', 'bn', 'bengali'],
  ['tam', '', 'ta', 'tamil'],
  ['tel', '', 'te', 'telugu'],
  ['mal', '', 'ml', 'malayalam'],
  ['kan', '', 'kn', 'kannada'],
  ['mar', '', 'mr', 'marathi'],
  ['pan', '', 'pa', 'punjabi'],
  ['urd', '', 'ur', 'urdu'],
  ['tha', '', 'th', 'thai'],
  ['vie', '', 'vi', 'vietnamese'],
  ['ind', '', 'id', 'indonesian'],
  ['may', 'msa', 'ms', 'malay'],
  ['tgl', '', 'tl', 'tagalog'],
  ['fil', '', '', 'filipino'],
  ['jpn', '', 'ja', 'japanese'],
  ['kor', '', 'ko', 'korean'],
  ['chi', 'zho', 'zh', 'chinese', 'mandarin'],
  ['afr', '', 'af', 'afrikaans'],
  ['swa', '', 'sw', 'swahili'],
  ['arm', 'hye', 'hy', 'armenian'],
  ['geo', 'kat', 'ka', 'georgian'],
  ['lat', '', 'la', 'latin'],
];

const buildIndex = (): ReadonlyMap<string, string> => {
  const index = new Map<string, string>();
  for (const row of LANGUAGES) {
    const canonical = row[0]!;
    for (const form of row) {
      if (form === '') continue;
      // A duplicate key would mean two rows claim the same spelling, and the
      // one that wins would depend on table order. Fail at import rather than
      // silently normalise a tag to whichever row happened to load first.
      const existing = index.get(form);
      if (existing !== undefined && existing !== canonical) {
        throw new Error(
          `Ambiguous language tag "${form}": claimed by both "${existing}" and "${canonical}".`,
        );
      }
      index.set(form, canonical);
    }
  }
  return index;
};

const INDEX = buildIndex();

/**
 * Reduce a tag to the form looked up in the table.
 *
 * Case, surrounding whitespace and repeated inner whitespace are all noise:
 * `English`, ` eng `, and `Modern  Greek` mean what their tidied forms mean.
 * A BCP-47 style region or script subtag is dropped (`en-US`, `pt_BR`, `zh-Hans`
 * → `en`, `pt`, `zh`), which is the one place this loses information on
 * purpose: trawlarr cannot represent "Brazilian Portuguese" as an ISO 639-2
 * code, and `por` is what the file is asking for.
 */
const lookupKey = (tag: string): string =>
  tag.trim().toLowerCase().replace(/\s+/g, ' ').split(/[-_]/)[0]!.trim();

/**
 * Canonicalise one language tag to ISO 639-2/B, or return it EXACTLY as given.
 *
 * Never guesses. `und`, `mis`, `mul`, `zxx`, the empty string and anything else
 * absent from the table come back unchanged, character for character.
 */
export const normalizeLanguageTag = (tag: string): string => INDEX.get(lookupKey(tag)) ?? tag;

/**
 * The whole point of this module, applied to a probe.
 *
 * Returns the SAME object when nothing changed, so the common case — a library
 * already tagged with ISO codes — costs one map lookup per stream and no
 * allocation, and so identity comparisons upstream keep working.
 *
 * This rewrites nothing on disk. It is a view of the probe, handed to plugins
 * in place of the raw one; the file's real tags, the probe stored in the
 * database, and the facts convergence is judged on all keep saying `English`.
 * The next scan therefore re-reads `English` and re-normalises it the same way
 * — the mapping is a pure function, so there is no state to drift and no loop.
 */
export const normalizeProbeLanguages = (probe: ProbeData): ProbeData => {
  const streams = probe.streams;
  if (streams === undefined) return probe;

  let changed = false;
  const normalized = streams.map((stream): ProbeStream => {
    const language = stream.tags?.language;
    if (typeof language !== 'string') return stream;
    const canonical = normalizeLanguageTag(language);
    if (canonical === language) return stream;
    changed = true;
    return { ...stream, tags: { ...stream.tags, language: canonical } };
  });

  return changed ? { ...probe, streams: normalized } : probe;
};
