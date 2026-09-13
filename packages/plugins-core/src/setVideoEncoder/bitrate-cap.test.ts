import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { bitrateCapPercentFrom, sourceVideoBitrate } from './bitrate-cap.js';

const probe = (data: ProbeData): ProbeData => data;

describe('sourceVideoBitrate', () => {
  it('matches a fresh video tag, derived without reading it (One Piece S07E01, from prod)', () => {
    const estimate = sourceVideoBitrate(
      probe({
        format: { bit_rate: '8611925', duration: '1438.165' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', tags: { BPS: '7972806' } },
          { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { BPS: '192000' } },
          { index: 2, codec_type: 'audio', codec_name: 'eac3', tags: { BPS: '224000' } },
          { index: 3, codec_type: 'audio', codec_name: 'eac3', tags: { BPS: '224000' } },
          { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { BPS: '159' } },
          { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { BPS: '88' } },
        ],
      } as ProbeData),
      0,
    );
    expect(estimate?.bitsPerSecond).toBe(7_971_678);
  });

  it('is not fooled by a stale video tag (Below Deck S11E13, AV1, from prod)', () => {
    // The tag survived an earlier remux and claims 4.59 Mbps in a file whose
    // WHOLE bitrate is 1.91. Capping at the tag would cap at more than double.
    const estimate = sourceVideoBitrate(
      probe({
        format: { bit_rate: '1906855', duration: '2564.266' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'av1', tags: { BPS: '4590661' } },
          { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { BPS: '125375' } },
          { index: 2, codec_type: 'subtitle', codec_name: 'ass', tags: { BPS: '103' } },
        ],
      } as ProbeData),
      0,
    );
    expect(estimate?.bitsPerSecond).toBe(1_781_377);
  });

  it('falls back to size over duration when the container reports no overall bitrate', () => {
    // 100 MB over 800 seconds is exactly 1 Mbps.
    const estimate = sourceVideoBitrate(
      probe({
        format: { duration: '800' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
      } as ProbeData),
      100,
    );
    expect(estimate?.bitsPerSecond).toBe(1_000_000);
  });

  it('ignores cover art, which is a video stream to ffprobe but not the programme', () => {
    const estimate = sourceVideoBitrate(
      probe({
        format: { bit_rate: '2000000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', bit_rate: '200000' },
          {
            index: 2,
            codec_type: 'video',
            codec_name: 'mjpeg',
            disposition: { attached_pic: 1 },
          },
        ],
      } as unknown as ProbeData),
      0,
    );
    expect(estimate?.bitsPerSecond).toBe(1_800_000);
  });

  it('uses the whole-file bitrate when the other streams claim more than the file holds', () => {
    // Nonsense tags must not produce a zero or negative cap.
    const estimate = sourceVideoBitrate(
      probe({
        format: { bit_rate: '1000000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { BPS: '5000000' } },
        ],
      } as ProbeData),
      0,
    );
    expect(estimate?.bitsPerSecond).toBe(1_000_000);
  });

  it('cannot tell when neither the bitrate nor size-and-duration are readable', () => {
    expect(sourceVideoBitrate(probe({ format: {}, streams: [] } as ProbeData), 0)).toBeNull();
  });
});

describe('bitrateCapPercentFrom', () => {
  it('reads unset as no cap', () => {
    expect(bitrateCapPercentFrom(undefined)).toBeNull();
    expect(bitrateCapPercentFrom('')).toBeNull();
  });

  it('reads a stored string and a number alike', () => {
    expect(bitrateCapPercentFrom('90')).toBe(90);
    expect(bitrateCapPercentFrom(100)).toBe(100);
  });

  it.each(['0', '101', '-5', 'abc', '90.5'])('refuses %s', (value) => {
    // Above 100 the cap no longer stops an encode outgrowing its source,
    // which is the only thing it is for.
    expect(() => bitrateCapPercentFrom(value)).toThrow(/Bitrate cap/);
  });
});
