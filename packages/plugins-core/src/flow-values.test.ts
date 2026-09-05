import { describe, expect, it } from 'vitest';
import {
  readFlowValue,
  renderMessageTemplate,
  type FlowValue,
  type FlowValueArgs,
} from './flow-values.js';
import { checkConditions, compareValue, details } from './checkCondition/index.js';

const args = (): FlowValueArgs => ({
  inputFileObj: {
    _id: '/media/Example.mkv',
    container: 'mkv',
    file_size: 1.5,
    bit_rate: 1000,
    ffProbeData: {
      format: { duration: '120.5', bit_rate: '1000000' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
          width: 500,
          height: 500,
        },
        {
          index: 3,
          codec_type: 'video',
          codec_name: 'hevc',
          width: 3840,
          height: 2160,
          color_transfer: 'smpte2084',
        },
        { index: 7, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'en' } },
        { index: 9, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'de' } },
        { index: 12, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
      ],
    },
  },
  originalLibraryFile: { _id: '/library/Original.mkv' },
  variables: { user: { target: 'hevc', literal: '{{not_evaluated}}' } },
  userVariables: { library: { language: 'eng' }, global: { limit: '4000' } },
  job: { jobId: 'job-1', fileId: 'file-1' },
});

describe('flow properties', () => {
  it('recovers integer byte sizes without decimal-MB rounding noise', () => {
    const input = args();
    input.inputFileObj.file_size = 197 / 1_000_000;
    expect(readFlowValue(input, 'file.sizeBytes')).toBe(197);
    input.inputFileObj.file_size = Number.MAX_VALUE;
    expect(readFlowValue(input, 'file.sizeBytes')).toBeUndefined();
  });

  it.each([
    ['file.path', '/media/Example.mkv'],
    ['file.name', 'Example.mkv'],
    ['file.id', 'file-1'],
    ['file.container', 'mkv'],
    ['file.sizeMb', 1.5],
    ['file.sizeBytes', 1_500_000],
    ['file.durationSeconds', 120.5],
    ['file.bitrate', 1_000_000],
    ['video.codec', 'hevc'],
    ['video.width', 3840],
    ['video.height', 2160],
    ['video.hdr', true],
    ['audio.count', 2],
    ['audio.languages', ['eng', 'ger']],
    ['audio.codecs', ['aac', 'ac3']],
    ['audio.maxChannels', 6],
    ['subtitle.count', 1],
    ['subtitle.languages', ['eng']],
    ['subtitle.codecs', ['subrip']],
    ['original.path', '/library/Original.mkv'],
    ['job.id', 'job-1'],
    ['user.target', 'hevc'],
    ['global.limit', '4000'],
    ['library.language', 'eng'],
  ])('reads %s in its documented units, excluding cover art', (field, expected) => {
    expect(readFlowValue(args(), String(field))).toEqual(expected);
  });

  it('distinguishes unprobed streams from a file known to have no audio/subtitles', () => {
    const input = args();
    input.inputFileObj.ffProbeData = {};
    expect(readFlowValue(input, 'audio.count')).toBeUndefined();
    expect(readFlowValue(input, 'subtitle.languages')).toBeUndefined();
    expect(readFlowValue(input, 'video.codec')).toBeUndefined();
    input.inputFileObj.ffProbeData.streams = [];
    expect(readFlowValue(input, 'audio.count')).toBe(0);
    expect(readFlowValue(input, 'audio.maxChannels')).toBe(0);
    expect(readFlowValue(input, 'subtitle.languages')).toEqual([]);
  });

  it.each([
    ['arib-std-b67', true],
    ['bt709', false],
    ['unknown', undefined],
    ['', undefined],
  ])('reads HDR transfer %s without guessing about missing metadata', (transfer, expected) => {
    const input = args();
    input.inputFileObj.ffProbeData.streams![1]!.color_transfer = transfer;
    expect(readFlowValue(input, 'video.hdr')).toBe(expected);
  });

  it('does not read inherited variables and reports unsupported property names', () => {
    expect(readFlowValue(args(), 'user.toString')).toBeUndefined();
    expect(() => readFlowValue(args(), 'process.env')).toThrow('Unknown flow property');
    expect(readFlowValue(args(), 'error.message')).toBeUndefined();
  });

  it('supports Windows filenames and untagged audio', () => {
    const input = args();
    input.inputFileObj._id = 'C:\\Media\\Example.mkv';
    input.inputFileObj.ffProbeData.streams![2]!.tags = {};
    expect(readFlowValue(input, 'file.name')).toBe('Example.mkv');
    expect(readFlowValue(input, 'audio.languages')).toEqual(['und', 'ger']);
  });
});

describe('message templates', () => {
  it('formats facts, booleans, lists and variables without evaluating substituted text', () => {
    expect(
      renderMessageTemplate(
        args(),
        '{{file.name}}: {{video.width}} / {{video.hdr}} / {{audio.languages}} / {{user.literal}}',
      ),
    ).toBe('Example.mkv: 3840 / true / eng, ger / {{not_evaluated}}');
  });

  it('exposes the original error to a recovery branch', () => {
    const input = args();
    input.variables.flowError = {
      message: 'Encoder unavailable',
      nodeId: 'encode',
      pluginId: 'trawlarr:execute',
      pluginName: 'Execute',
    };
    expect(
      renderMessageTemplate(input, '{{error.nodeId}} ({{error.pluginName}}): {{error.message}}'),
    ).toBe('encode (Execute): Encoder unavailable');
    expect(readFlowValue(input, 'error.pluginId')).toBe('trawlarr:execute');
  });

  it.each([
    '{{user.missing}}',
    '{{error.message}}',
    '{{unknown}}',
    '{{}}',
    '{{process.exit()}}',
    '{{file.path',
    'file.path}}',
  ])('rejects unavailable, unknown or malformed template %s', (text) => {
    expect(() => renderMessageTemplate(args(), text)).toThrow();
  });
});

describe('condition comparisons', () => {
  const comparisons: Array<[FlowValue | undefined, string, string, boolean]> = [
    ['HEVC', 'equals', 'hevc', true],
    ['hevc', 'not equals', 'h264', true],
    [100, 'equals', '100', true],
    [100, 'not equals', '101', true],
    [100, 'greater than', '99', true],
    [100, 'at least', '100', true],
    [100, 'less than', '100', false],
    [100, 'at most', '100', true],
    [true, 'equals', 'true', true],
    [false, 'not equals', 'true', true],
    ['/Movies/a.mkv', 'contains', 'movies', true],
    ['abc', 'does not contain', 'x', true],
    [['eng', 'jpn'], 'contains', 'ENG', true],
    [['eng'], 'contains', 'en', false],
    [['eng'], 'does not contain', 'jpn', true],
    [undefined, 'exists', '', false],
    [undefined, 'is missing', '', true],
    [undefined, 'not equals', 'anything', false],
    [0, 'exists', '', true],
  ];
  it.each(comparisons)('compares %j %s %s', (actual, operator, expected, result) => {
    expect(compareValue(actual, operator, expected, false)).toBe(result);
  });

  it('honors case sensitivity and refuses type/configuration errors', () => {
    expect(compareValue('HEVC', 'equals', 'hevc', true)).toBe(false);
    expect(() => compareValue(2, 'at least', '2x', false)).toThrow('finite number');
    expect(() => compareValue(undefined, 'at least', '2x', false)).toThrow('finite number');
    expect(() => compareValue(false, 'less than', '2', false)).toThrow('finite number');
    expect(() => compareValue(true, 'equals', 'yes', false)).toThrow('true or false');
    expect(() => compareValue(['eng'], 'equals', 'eng', false)).toThrow('Use contains');
    expect(() => compareValue(1, 'contains', '1', false)).toThrow('Contains needs');
    expect(() => compareValue('a', 'unknown', 'a', false)).toThrow('Unknown condition');
  });

  it('combines enabled conditions with AND or OR and supports value templates', () => {
    const input = {
      conditionCount: 2,
      field1: 'video.codec',
      value1: '{{user.target}}',
      field2: 'video.width',
      operator2: 'at least',
      value2: '4000',
      field3: 'invalid-but-disabled',
    };
    expect(checkConditions(args(), { ...input, match: 'all' }).matches).toBe(false);
    expect(checkConditions(args(), { ...input, match: 'any' }).matches).toBe(true);
    expect(checkConditions(args(), { ...input, match: 'all', value2: '3840' }).matches).toBe(true);
    expect(
      checkConditions(args(), {
        field1: 'error.message',
        operator1: 'is missing',
        value1: '{{unknown}}',
      }).matches,
    ).toBe(true);
  });

  it('checks all enabled rules instead of hiding invalid rules behind a short circuit', () => {
    expect(() =>
      checkConditions(args(), { conditionCount: 2, match: 'any', field2: 'unknown' }),
    ).toThrow('Unknown flow property');
    for (const count of [0, 5, 1.5, 'bad'])
      expect(() => checkConditions(args(), { conditionCount: count })).toThrow();
    expect(() => checkConditions(args(), { match: 'none' })).toThrow('all or any');
  });

  it('describes both outputs and condition-count-driven fields for the generic editor', () => {
    const metadata = details();
    expect(metadata.outputs.map((output) => output.number)).toEqual([1, 2]);
    expect(
      metadata.inputs.find((input) => input.name === 'field4')?.inputUI.displayConditions,
    ).toBeDefined();
    expect(
      metadata.inputs.find((input) => input.name === 'value1')?.inputUI.displayConditions?.sets[0]
        ?.inputs,
    ).toContainEqual({ name: 'operator1', condition: '!==', value: 'is missing' });
  });
});
