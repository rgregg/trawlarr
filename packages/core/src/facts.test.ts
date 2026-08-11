import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import {
  DEFAULT_FACT_TOLERANCE,
  extractFacts,
  factsEquivalent,
  factsHash,
  type FactSet,
} from './facts.js';

const probe: ProbeData = {
  format: { duration: '1440.5', nb_streams: 3 },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'eac3', tags: { language: 'eng' } },
    {
      codec_type: 'subtitle',
      codec_name: 'subrip',
      tags: { language: 'eng', title: 'Commentary' },
      disposition: { comment: 1 },
    },
  ],
};

const facts = (over: Partial<FactSet> = {}): FactSet => ({
  ...extractFacts({ probe, container: 'mkv', sizeBytes: 40_000_000_000 }),
  ...over,
});

describe('extractFacts', () => {
  it('captures container, size, duration and dimensions', () => {
    const f = extractFacts({ probe, container: 'mkv', sizeBytes: 1234 });
    expect(f.container).toBe('mkv');
    expect(f.sizeBytes).toBe(1234);
    expect(f.durationMs).toBe(1_440_500);
    expect(f.width).toBe(1920);
    expect(f.height).toBe(1080);
  });

  it('records one fact per stream, in stream order, with index', () => {
    const f = extractFacts({ probe, container: 'mkv', sizeBytes: 1 });
    expect(f.streams).toHaveLength(3);
    expect(f.streams[0]).toEqual({
      index: 0,
      codecType: 'video',
      codecName: 'h264',
      language: null,
      disposition: null,
    });
    expect(f.streams[1]?.language).toBe('eng');
    expect(f.streams[2]?.disposition).toBe('comment');
  });

  it('tolerates a probe with no streams or format', () => {
    const f = extractFacts({ probe: {}, container: 'mp4', sizeBytes: 0 });
    expect(f.streams).toEqual([]);
    expect(f.durationMs).toBeNull();
    expect(f.width).toBeNull();
  });

  it('ignores an unparseable duration rather than producing NaN', () => {
    const f = extractFacts({
      probe: { format: { duration: 'N/A' } },
      container: 'mkv',
      sizeBytes: 1,
    });
    expect(f.durationMs).toBeNull();
  });
});

describe('factsEquivalent', () => {
  it('is true for identical fact sets', () => {
    expect(factsEquivalent(facts(), facts())).toBe(true);
  });

  it('tolerates small duration drift from re-muxing', () => {
    const a = facts({ durationMs: 1_440_500 });
    const b = facts({ durationMs: 1_440_500 + DEFAULT_FACT_TOLERANCE.durationMs - 1 });
    expect(factsEquivalent(a, b)).toBe(true);
  });

  it('rejects duration drift beyond tolerance', () => {
    const a = facts({ durationMs: 1_440_500 });
    const b = facts({ durationMs: 1_440_500 + DEFAULT_FACT_TOLERANCE.durationMs + 1 });
    expect(factsEquivalent(a, b)).toBe(false);
  });

  it('tolerates small size drift but not a real re-encode', () => {
    const a = facts({ sizeBytes: 40_000_000_000 });
    expect(factsEquivalent(a, facts({ sizeBytes: 40_020_000_000 }))).toBe(true);
    expect(factsEquivalent(a, facts({ sizeBytes: 12_000_000_000 }))).toBe(false);
  });

  it('detects a codec change — the signal that work actually happened', () => {
    const before = facts();
    const after = facts({
      streams: before.streams.map((s: (typeof before.streams)[0], i: number) =>
        i === 0 ? { ...s, codecName: 'hevc' } : s,
      ),
    });
    expect(factsEquivalent(before, after)).toBe(false);
  });

  it('detects a dropped stream', () => {
    const before = facts();
    expect(factsEquivalent(before, facts({ streams: before.streams.slice(0, 2) }))).toBe(false);
  });

  it('detects a container change', () => {
    expect(factsEquivalent(facts(), facts({ container: 'mp4' }))).toBe(false);
  });

  it('treats one null duration and one known duration as different', () => {
    expect(factsEquivalent(facts({ durationMs: null }), facts())).toBe(false);
  });

  it('treats two unknown durations as equivalent', () => {
    expect(factsEquivalent(facts({ durationMs: null }), facts({ durationMs: null }))).toBe(true);
  });
});

describe('factsHash', () => {
  it('is stable and order-independent for equal content', () => {
    expect(factsHash(facts())).toBe(factsHash(facts()));
  });

  it('changes when any fact changes', () => {
    expect(factsHash(facts())).not.toBe(factsHash(facts({ container: 'mp4' })));
  });

  it('is exact, not tolerant — size drift changes the hash', () => {
    // factsHash decides "should we re-evaluate"; factsEquivalent decides
    // "did work accomplish anything". They intentionally differ.
    expect(factsHash(facts({ sizeBytes: 1 }))).not.toBe(factsHash(facts({ sizeBytes: 2 })));
  });
});
