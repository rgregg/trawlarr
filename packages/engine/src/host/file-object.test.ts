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
    // Tdarr contract: file_size is MEGABYTES, not bytes. Evidence:
    // CommunityFlowPlugins/file/checkFileSize/1.0.0/index.js:75 —
    // `fileSizeBytes = args.inputFileObj.file_size * 1000 * 1000`.
    expect(file.file_size).toBe(8_000); // 8_000_000_000 bytes -> 8000 MB
    // bit_rate is untouched: ffprobe's format.bit_rate is already bits/sec,
    // and CommunityFlowPlugins/video/checkOverallBitrate/1.0.0/index.js logs
    // it directly as "... bps".
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

  it('reports size history so size-comparison plugins work, projected in megabytes', () => {
    const file = toPluginFileObject(source());
    // Tdarr contract: oldSize/newSize are megabytes, same as file_size.
    // Community/Tdarr_Plugin_a9he_New_file_size_check.js reads them straight
    // off `file.file_size` / `originalLibraryFile.file_size` and logs them
    // with an explicit "MB" suffix.
    expect(file.oldSize).toBe(12_000); // 12_000_000_000 bytes -> 12000 MB
    expect(file.newSize).toBe(8_000); // 8_000_000_000 bytes -> 8000 MB
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

  it('round-trips newSize through the MB projection back to the original byte count', () => {
    // Guards against the class of bug this task fixes: newSize is projected
    // in MB, so absorbing it back MUST reconvert to bytes, or a plugin that
    // merely passes the file object through unchanged would cause trawlarr
    // to record a size a million times too small.
    const file = toPluginFileObject(source());
    expect(absorbPluginFileObject(file).newSizeBytes).toBe(8_000_000_000);
  });

  it('absorbs a plugin-modified newSize (MB) back into bytes', () => {
    const file = toPluginFileObject(source());
    file.newSize = 4_000; // plugin reports a 4000 MB output file
    expect(absorbPluginFileObject(file).newSizeBytes).toBe(4_000_000_000);
  });

  it('returns a WHOLE number of bytes for a size the MB round-trip cannot express', () => {
    // A real 2.14 GB file: 2143639320 bytes projects to 2143.63932 MB and
    // multiplies back to 2143639320.0000002. A byte count is a whole number
    // by definition and the column holding it has INTEGER affinity, so the
    // rounding belongs here, at the producer, rather than in every consumer
    // that has to remember it. Replace Original File is what first makes such
    // values routine: it re-stats the file after the swap and writes the real
    // size back through this contract.
    const bytes = 2_143_639_320;
    expect((bytes / 1_000_000) * 1_000_000).not.toBe(bytes); // the hazard is real
    const file = toPluginFileObject(source());
    file.newSize = bytes / 1_000_000;
    const absorbed = absorbPluginFileObject(file).newSizeBytes;
    expect(absorbed).toBe(bytes);
    expect(Number.isInteger(absorbed)).toBe(true);
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
