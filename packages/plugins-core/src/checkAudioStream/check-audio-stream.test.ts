import { describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeStream } from '@trawlarr/plugin-api';
import { emptyFfmpegCommand } from '@trawlarr/core';
import { plugin } from './index.js';

const args = (streams: ProbeStream[], inputs: Record<string, unknown>): PluginInputArgs =>
  ({
    inputFileObj: {
      _id: '/media/movie.mkv',
      container: 'mkv',
      ffProbeData: { format: { duration: '60' }, streams },
    },
    variables: { ffmpegCommand: emptyFfmpegCommand(), flowFailed: false, user: {} },
    inputs,
    jobLog: () => {},
  }) as unknown as PluginInputArgs;

const video: ProbeStream = { index: 0, codec_type: 'video', codec_name: 'h264' } as ProbeStream;
const aac51: ProbeStream = {
  index: 1,
  codec_type: 'audio',
  codec_name: 'aac',
  channels: 6,
} as ProbeStream;
const ac3Stereo: ProbeStream = {
  index: 2,
  codec_type: 'audio',
  codec_name: 'ac3',
  channels: 2,
} as ProbeStream;
const aacStereo: ProbeStream = {
  index: 3,
  codec_type: 'audio',
  codec_name: 'aac',
  channels: 2,
} as ProbeStream;

describe('trawlarr:checkAudioStream', () => {
  it('requires the criteria to hold on ONE stream, not across the file', () => {
    // The defect this node exists for: a 5.1 AAC track beside a stereo AC3
    // track satisfies "codecs contains aac" and "channels contains 2" as two
    // separate conditions, but there is no 2-channel AAC track here.
    const result = plugin(args([video, aac51, ac3Stereo], { codec: 'aac', channels: 2 }));
    expect(result.outputNumber).toBe(2);
  });

  it('matches when one stream really does carry every criterion', () => {
    const result = plugin(
      args([video, aac51, ac3Stereo, aacStereo], { codec: 'aac', channels: 2 }),
    );
    expect(result.outputNumber).toBe(1);
  });

  it('accepts libfdk_aac as aac, since that is the same codec by another encoder', () => {
    const libfdk = { ...aacStereo, codec_name: 'libfdk_aac' } as ProbeStream;
    expect(plugin(args([video, libfdk], { codec: 'aac', channels: 2 })).outputNumber).toBe(1);
  });

  it('ignores video streams even when they would otherwise match', () => {
    const oddVideo = { index: 0, codec_type: 'video', codec_name: 'aac', channels: 2 };
    expect(
      plugin(args([oddVideo as ProbeStream], { codec: 'aac', channels: 2 })).outputNumber,
    ).toBe(2);
  });

  it('treats a blank criterion as "any", so codec alone is a plain codec test', () => {
    expect(plugin(args([video, aac51], { codec: 'aac' })).outputNumber).toBe(1);
    expect(plugin(args([video, aac51], { channels: 6 })).outputNumber).toBe(1);
    expect(plugin(args([video, aac51], { channels: 2 })).outputNumber).toBe(2);
  });

  it('matches language the same way the audio.languages property normalizes it', () => {
    const eng = { ...aacStereo, tags: { language: 'eng' } } as ProbeStream;
    const fre = { ...aacStereo, index: 4, tags: { language: 'fre' } } as ProbeStream;
    expect(plugin(args([eng, fre], { codec: 'aac', language: 'en' })).outputNumber).toBe(1);
    expect(plugin(args([eng], { codec: 'aac', language: 'de' })).outputNumber).toBe(2);
  });

  it('does not count a stream whose channel count cannot be read', () => {
    const unreadable = { index: 1, codec_type: 'audio', codec_name: 'aac' } as ProbeStream;
    expect(plugin(args([unreadable], { codec: 'aac', channels: 2 })).outputNumber).toBe(2);
    // ...but with no channel criterion there is nothing unreadable about it.
    expect(plugin(args([unreadable], { codec: 'aac' })).outputNumber).toBe(1);
  });

  it('refuses a file with no probe data rather than reporting "no match"', () => {
    const unprobed = {
      inputFileObj: { _id: '/media/movie.mkv', ffProbeData: {} },
      variables: { ffmpegCommand: emptyFfmpegCommand(), flowFailed: false, user: {} },
      inputs: { codec: 'aac' },
      jobLog: () => {},
    } as unknown as PluginInputArgs;
    // Answering "no match" would send the file down the converting branch on
    // the strength of data nobody read.
    expect(() => plugin(unprobed)).toThrow(/no probe data/i);
  });

  it('refuses a node with every criterion blank instead of passing every file', () => {
    expect(() => plugin(args([aacStereo], {}))).toThrow(/at least one/i);
  });

  it('refuses a channel count that is not a number', () => {
    expect(() => plugin(args([aacStereo], { channels: 'stereo' }))).toThrow(/must be a number/i);
  });
});
