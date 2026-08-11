import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import {
  absorbPluginFileObject,
  projectTranscodeDecision,
  toPluginFileObject,
  type ProjectionSource,
} from './file-object.js';

const probe: ProbeData = {
  format: { duration: '5400.0', bit_rate: '8000000', nb_streams: 2 },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'eac3', tags: { language: 'eng' } },
  ],
};

const source = (over: Partial<ProjectionSource> = {}): ProjectionSource => ({
  fileId: 'file-1',
  libraryId: 'lib-movies',
  footprintId: '2049:42',
  path: '/media/movies/Arrival.mkv',
  container: 'mkv',
  sizeBytes: 8_000_000_000,
  originalSizeBytes: 12_000_000_000,
  mtimeMs: 1_700_000_000_000,
  ctimeMs: 1_699_000_000_000,
  probe,
  state: 'good',
  lastRunModified: true,
  holdUntilMs: null,
  lastTranscodeMs: 1_700_000_500_000,
  lastHealthCheckMs: null,
  history: '',
  discoveredAtMs: 1_690_000_000_000,
  ...over,
});

describe('toPluginFileObject', () => {
  it('puts the PATH in _id, because that is what the contract means', () => {
    const file = toPluginFileObject(source());
    expect(file._id).toBe('/media/movies/Arrival.mkv');
    expect(file.file).toBe('/media/movies/Arrival.mkv');
  });

  it('projects trawlarr identity into footprintId, keeping it separate from _id', () => {
    const file = toPluginFileObject(source());
    expect(file.footprintId).toBe('2049:42');
    expect(file.footprintId).not.toBe(file._id);
  });

  it('carries the probe payload through untouched', () => {
    expect(toPluginFileObject(source()).ffProbeData).toEqual(probe);
  });

  it('denormalises the fields plugins commonly read', () => {
    const file = toPluginFileObject(source());
    expect(file.video_codec_name).toBe('h264');
    expect(file.audio_codec_name).toBe('eac3');
    expect(file.video_resolution).toBe('1080p');
    expect(file.videoStreamIndex).toBe(0);
    expect(file.container).toBe('mkv');
    expect(file.file_size).toBe(8_000_000_000);
    expect(file.bit_rate).toBe(8_000_000);
  });

  it('classifies common resolutions', () => {
    const at = (width: number, height: number) =>
      toPluginFileObject(
        source({
          probe: { streams: [{ codec_type: 'video', codec_name: 'h264', width, height }] },
        }),
      ).video_resolution;
    expect(at(3840, 2160)).toBe('4KUHD');
    expect(at(1920, 1080)).toBe('1080p');
    expect(at(1280, 720)).toBe('720p');
    expect(at(720, 480)).toBe('480p');
  });

  it('reports which scanner reads have happened', () => {
    const bare = toPluginFileObject(source());
    expect(bare.scannerReads.ffProbeRead).toBe('true');
    expect(bare.scannerReads.exiftoolRead).toBe('false');

    const enriched = toPluginFileObject(source({ exiftool: { FileType: 'MKV' } }));
    expect(enriched.scannerReads.exiftoolRead).toBe('true');
    expect(enriched.meta).toEqual({ FileType: 'MKV' });
  });

  it('omits meta and mediaInfo when those probes have not run', () => {
    const file = toPluginFileObject(source());
    expect(file.meta).toBeUndefined();
    expect(file.mediaInfo).toBeUndefined();
  });

  it('reports size history so size-comparison plugins work', () => {
    const file = toPluginFileObject(source());
    expect(file.oldSize).toBe(12_000_000_000);
    expect(file.newSize).toBe(8_000_000_000);
  });

  it('survives a probe with no streams', () => {
    const file = toPluginFileObject(source({ probe: {} }));
    expect(file.video_codec_name).toBe('');
    expect(file.video_resolution).toBe('');
    expect(file.videoStreamIndex).toBe(0);
  });
});

describe('projectTranscodeDecision', () => {
  it('maps ledger state onto the legacy enum plugins branch on', () => {
    expect(projectTranscodeDecision('good', true)).toBe('Transcode success');
    expect(projectTranscodeDecision('good', false)).toBe('Not required');
    expect(projectTranscodeDecision('queued', false)).toBe('Queued');
    expect(projectTranscodeDecision('held', false)).toBe('Hold');
    expect(projectTranscodeDecision('failed', false)).toBe('Transcode error');
    expect(projectTranscodeDecision('not_converging', true)).toBe('Transcode error');
    expect(projectTranscodeDecision('running', false)).toBe('');
    expect(projectTranscodeDecision('unknown', false)).toBe('');
  });
});

describe('absorbPluginFileObject', () => {
  it('picks up a path change a plugin made', () => {
    const file = toPluginFileObject(source());
    file._id = '/media/movies/Arrival.mp4';
    expect(absorbPluginFileObject(file).path).toBe('/media/movies/Arrival.mp4');
  });

  it('picks up status writes, which plugins really do perform', () => {
    const file = toPluginFileObject(source());
    file.HealthCheck = 'Error';
    file.TranscodeDecisionMaker = 'Transcode error';
    const absorbed = absorbPluginFileObject(file);
    expect(absorbed.healthStatus).toBe('Error');
    expect(absorbed.transcodeDecision).toBe('Transcode error');
  });

  it('picks up holdUntil and bumped, mapping onto scheduling', () => {
    const file = toPluginFileObject(source());
    file.holdUntil = 1_800_000_000_000;
    file.bumped = true;
    const absorbed = absorbPluginFileObject(file);
    expect(absorbed.holdUntilMs).toBe(1_800_000_000_000);
    expect(absorbed.bumped).toBe(true);
  });

  it('treats a zero holdUntil as no hold', () => {
    const file = toPluginFileObject(source());
    file.holdUntil = 0;
    expect(absorbPluginFileObject(file).holdUntilMs).toBeNull();
  });

  it('ignores nonsense values rather than corrupting state', () => {
    const file = toPluginFileObject(source());
    (file as Record<string, unknown>).HealthCheck = 'Bananas';
    (file as Record<string, unknown>).holdUntil = 'soon';
    const absorbed = absorbPluginFileObject(file);
    expect(absorbed.healthStatus).toBe('');
    expect(absorbed.holdUntilMs).toBeNull();
  });
});
