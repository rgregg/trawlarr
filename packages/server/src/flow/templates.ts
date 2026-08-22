import type { FlowDefinition } from '@trawlarr/core';

export interface FlowTemplateParameter {
  name: string;
  label: string;
  type: 'string';
  defaultValue: string;
  options?: string[];
  tooltip: string;
}

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  parameters: FlowTemplateParameter[];
  /**
   * Community plugin NAMES (no source prefix) this template's nodes refer to.
   * A caller prefixes each with the source the user chose and refuses to
   * store the flow when one is missing: validation treats an unresolvable
   * plugin as UNKNOWN rather than wrong, so a template naming a plugin that
   * was never synced would validate, store, attach, and then fail on the
   * first file with an error naming that file rather than the missing
   * plugin.
   */
  requiredPlugins: string[];
  build(values: Record<string, string>): FlowDefinition;
}

export class UnknownTemplateError extends Error {
  constructor(templateId: string, known: string[]) {
    super(
      `No flow template "${templateId}". Available templates: ${known.join(', ')}. List them ` +
        `with GET /api/v1/flows/templates.`,
    );
    this.name = 'UnknownTemplateError';
  }
}

const PLUGIN_VERSION = '1.0.0';

const transcodeParameters: FlowTemplateParameter[] = [
  {
    name: 'targetCodec',
    label: 'Target video codec',
    type: 'string',
    defaultValue: 'hevc',
    options: ['hevc', 'h264', 'av1'],
    tooltip:
      'A file whose video already uses this codec is left alone. This is the test that stops ' +
      'the flow re-encoding what it has already converted.',
  },
  {
    name: 'encoder',
    label: 'Encoder',
    type: 'string',
    defaultValue: 'libx265',
    options: ['libx265', 'libx264', 'hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'],
    tooltip:
      'The ffmpeg encoder that produces the target codec. A hardware encoder requires that ' +
      'hardware to be declared on this node AND present in the ffmpeg build.',
  },
  {
    name: 'quality',
    label: 'Quality',
    type: 'string',
    defaultValue: '24',
    tooltip:
      'Lower is better quality and larger files; 20–24 is usually visually lossless. The flag ' +
      'this becomes (-crf, -cq, -qp, -global_quality) depends on the encoder and is chosen for ' +
      'you.',
  },
  {
    name: 'hardwareDecoding',
    label: 'Decode on the same hardware as the encoder',
    type: 'string',
    defaultValue: 'false',
    options: ['false', 'true'],
    tooltip:
      'Adds an -hwaccel flag ahead of the input so the GPU decodes as well as encodes. With a ' +
      'hardware encoder and this off, every frame is still decoded on the CPU, which is what ' +
      'saturates a small host while the GPU idles. It does nothing for a software encoder, and ' +
      'a machine that has not really got the declared hardware fails every file rather than ' +
      'falling back.',
  },
  {
    name: 'trashRetentionDays',
    label: 'Keep replaced originals for (days)',
    type: 'string',
    defaultValue: '14',
    tooltip:
      'Replaced originals move to <library root>/.trawlarr/trash and are purged after this ' +
      'many days. This is what every mistake is recoverable from; shorten it deliberately.',
  },
];

/**
 * The stack a typical Unmanic transcode library runs, expressed in trawlarr's
 * own nodes: skip what is already the target codec, otherwise build one
 * ffmpeg command, encode, verify the result, and replace the original with
 * the old one kept in trash.
 *
 * `Check Video Codec` output 1 ("already this codec") DELIBERATELY HAS NO
 * OUTGOING EDGE. Routing it anywhere that leads to Execute would re-encode
 * converged files for ever — the failure mode trawlarr's convergence ledger
 * exists to make visible, and one a template must not create.
 */
const transcodeHevc: FlowTemplate = {
  id: 'transcode-hevc',
  name: 'Transcode video to a target codec',
  description:
    'Transcode any file whose video is not already the target codec, verify the result, and ' +
    'replace the original. The equivalent of a standard Unmanic transcode stack.',
  parameters: transcodeParameters,
  requiredPlugins: [],
  build: (values) => {
    const value = (name: string): string => {
      const given = values[name];
      const parameter = transcodeParameters.find((candidate) => candidate.name === name)!;
      // An empty string is a MISSING value, not a chosen one: it arrives from
      // an untouched form field and from `--set quality=`, and passing it
      // through would put `""` where the node expects a codec or an encoder
      // — a flow that validates and then fails on the first file.
      return given === undefined || given === '' ? parameter.defaultValue : given;
    };

    return {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'check',
          pluginId: 'trawlarr:checkVideoCodec',
          pluginVersion: PLUGIN_VERSION,
          inputs: { codec: value('targetCodec') },
        },
        {
          id: 'begin',
          pluginId: 'trawlarr:beginCommand',
          pluginVersion: PLUGIN_VERSION,
          inputs: {},
        },
        {
          id: 'encoder',
          pluginId: 'trawlarr:setVideoEncoder',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            encoder: value('encoder'),
            quality: value('quality'),
            hardwareDecoding: value('hardwareDecoding'),
          },
        },
        { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'verify',
          pluginId: 'trawlarr:verifyOutput',
          pluginVersion: PLUGIN_VERSION,
          inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
        },
        {
          id: 'replace',
          pluginId: 'trawlarr:replaceOriginal',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            trashRetentionDays: value('trashRetentionDays'),
            allowCrossDevice: 'true',
          },
        },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
        { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
        { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
        { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
        { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
      ],
    };
  },
};

const conformParameters: FlowTemplateParameter[] = [
  {
    name: 'pluginSource',
    label: 'Plugin source name',
    type: 'string',
    defaultValue: 'tdarr',
    tooltip:
      'The name you gave the plugin source with "trawlarr plugin source add". It prefixes ' +
      'every community plugin id this template uses, because you choose your own source name.',
  },
  {
    name: 'container',
    label: 'Destination container',
    type: 'string',
    defaultValue: 'mkv',
    options: ['mkv', 'mp4'],
    tooltip:
      'Files already in this container are not remuxed — the node compares against the ' +
      'file extension, so a converged library costs nothing here.',
  },
  {
    name: 'targetCodec',
    label: 'Target video codec',
    type: 'string',
    defaultValue: 'hevc',
    options: ['hevc', 'h264', 'av1'],
    tooltip:
      'A file whose video already uses this codec skips the encoder — but NOT the rest of ' +
      'the flow, because it may still need a remux, an audio track or a language filter.',
  },
  {
    name: 'encoder',
    label: 'Encoder',
    type: 'string',
    defaultValue: 'hevc_nvenc',
    options: ['hevc_nvenc', 'libx265', 'libx264', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'],
    tooltip:
      'A hardware encoder requires that hardware to be declared on this node AND present in ' +
      'the ffmpeg build. Trawlarr never falls back to software: a wrong declaration produces ' +
      'failing jobs, three attempts per file.',
  },
  {
    name: 'hardwareDecoding',
    label: 'Decode on the same hardware as the encoder',
    type: 'string',
    defaultValue: 'false',
    options: ['false', 'true'],
    tooltip:
      'Adds an -hwaccel flag ahead of the input so the GPU decodes as well as encodes. With a ' +
      'hardware encoder and this off, every frame is still decoded on the CPU, which is what ' +
      'saturates a small host while the GPU idles. It does nothing for a software encoder, and ' +
      'a machine that has not really got the declared hardware fails every file rather than ' +
      'falling back.',
  },
  {
    name: 'quality',
    label: 'Quality',
    type: 'string',
    defaultValue: '23',
    tooltip:
      'Lower is better quality and larger files. The flag this becomes (-crf, -cq, -qp, ' +
      '-global_quality) depends on the encoder and is chosen for you.',
  },
  {
    name: 'audioLanguage',
    label: 'Audio language to guarantee',
    type: 'string',
    defaultValue: 'eng',
    tooltip:
      'A stereo AAC track in this language is ADDED if the file does not already have one. ' +
      'Note "added", not "converted" — the original track is kept beside it.',
  },
  {
    name: 'keepLanguages',
    label: 'Audio languages to keep',
    type: 'string',
    defaultValue: 'eng',
    tooltip:
      'Comma-separated. Audio in any other language is removed. A track with NO language ' +
      'tag is always kept — the plugin never judges a stream whose language is missing, ' +
      'which is what stops a badly-tagged rip losing all of its audio.',
  },
  {
    name: 'preset',
    label: 'Encoder preset',
    type: 'string',
    defaultValue: '',
    tooltip:
      'Optional, and encoder-specific: NVENC takes p1-p7 (Unmanic\'s "preset 4" is p4), ' +
      'libx264/libx265 take ultrafast through placebo. Left empty by default because a ' +
      'preset name valid for one encoder is an invalid argument for the other, and ffmpeg ' +
      'fails outright rather than ignoring it.',
  },
  {
    name: 'maxMuxingQueueSize',
    label: 'Max muxing queue size',
    type: 'string',
    defaultValue: '2048',
    tooltip:
      "Raises ffmpeg's muxing queue. Needed for files that would otherwise fail with " +
      '"Too many packets buffered for output stream".',
  },
  {
    name: 'trashRetentionDays',
    label: 'Keep replaced originals for (days)',
    type: 'string',
    defaultValue: '14',
    tooltip:
      'Replaced originals move to <library root>/.trawlarr/trash and are purged after this ' +
      'many days. This is what every mistake is recoverable from; shorten it deliberately.',
  },
];

/**
 * The full parity stack an Unmanic library runs, in one flow: remux, encode
 * what is not already the target codec, guarantee a stereo AAC track, drop
 * audio in languages the user does not want, verify, replace.
 *
 * ONE template covers both a Movies and a Shows library even when Unmanic ran
 * them with "Ensure 2ch AAC" on opposite sides of the transcode. Unmanic runs
 * a separate ffmpeg pass per plugin, so there plugin order IS encode order;
 * here every command-building node contributes to a SINGLE ffmpeg invocation
 * compiled once by `compileFfmpegArgs`, and the audio node and the encoder
 * node touch different streams. Their order cannot change the argv.
 *
 * Two things that look like simplifications and are not:
 *
 * - `forceConform` is `false`. It removes streams the target container cannot
 *   carry, which is right for mkv->mp4 and wrong as a default: for a library
 *   already in the target container it can only take things away.
 * - `muxqueue` sits on the COMMON path, after the branches rejoin. `Custom
 *   Arguments` pushes to `overallOuputArguments`, and `deriveShouldProcess`
 *   reads a non-empty `overallOuputArguments` as work to be done — so a
 *   converged file passing through it would run ffmpeg for ever. That is
 *   harmless here only because this flow always remuxes or transcodes
 *   something by the time it reaches Execute; moving the node means
 *   re-checking that claim.
 */
const conformLibrary: FlowTemplate = {
  id: 'conform-library',
  name: 'Remux, transcode, and conform audio and languages',
  description:
    'The full parity stack: remux to one container, transcode video that is not already the ' +
    'target codec, guarantee a stereo AAC track, drop audio in unwanted languages, verify, ' +
    'and replace the original. Requires community plugins — sync a plugin source first.',
  parameters: conformParameters,
  requiredPlugins: [
    'ffmpegCommandSetContainer',
    'ffmpegCommandCustomArguments',
    'ffmpegCommandEnsureAudioStream',
    'ffmpegCommandRemoveStreamByProperty',
  ],
  build: (values) => {
    const value = (name: string): string => {
      const given = values[name];
      const parameter = conformParameters.find((candidate) => candidate.name === name)!;
      // An empty string is a MISSING value, not a chosen one: it arrives from
      // an untouched form field and from `--set quality=`, and passing it
      // through would put "" where a node expects a codec. `preset` is the
      // one parameter whose default IS empty, which is what makes "no preset"
      // expressible at all.
      return given === undefined || given === '' ? parameter.defaultValue : given;
    };
    const community = (pluginName: string): string => `${value('pluginSource')}:${pluginName}`;

    return {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'begin',
          pluginId: 'trawlarr:beginCommand',
          pluginVersion: PLUGIN_VERSION,
          inputs: {},
        },
        {
          id: 'container',
          pluginId: community('ffmpegCommandSetContainer'),
          pluginVersion: PLUGIN_VERSION,
          // forceConform removes streams the target container cannot carry.
          // Right for mkv->mp4, wrong as a default: for a library already in
          // the target container it can only take things away.
          inputs: { container: value('container'), forceConform: 'false' },
        },
        {
          id: 'check',
          pluginId: 'trawlarr:checkVideoCodec',
          pluginVersion: PLUGIN_VERSION,
          inputs: { codec: value('targetCodec') },
        },
        {
          id: 'encoder',
          pluginId: 'trawlarr:setVideoEncoder',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            encoder: value('encoder'),
            quality: value('quality'),
            hardwareDecoding: value('hardwareDecoding'),
          },
        },
        {
          id: 'muxqueue',
          pluginId: community('ffmpegCommandCustomArguments'),
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            inputArguments: '',
            // The preset is appended here rather than set on Set Video
            // Encoder, which has no preset input. It reaches the encoder as a
            // global output option, which is safe because the video is the
            // only stream being encoded — a copied audio stream ignores it.
            outputArguments: [
              `-max_muxing_queue_size ${value('maxMuxingQueueSize')}`,
              value('preset') === '' ? '' : `-preset ${value('preset')}`,
            ]
              .filter((part) => part !== '')
              .join(' '),
          },
        },
        {
          id: 'audio',
          pluginId: community('ffmpegCommandEnsureAudioStream'),
          pluginVersion: PLUGIN_VERSION,
          // ADDS a stereo AAC track when there is not one already; it does
          // NOT convert the existing track, which is where this diverges from
          // Unmanic's `ensure_2ch_aac_audio`. See docs/migrating-from-unmanic.md.
          inputs: { audioEncoder: 'aac', language: value('audioLanguage'), channels: '2' },
        },
        {
          id: 'language',
          pluginId: community('ffmpegCommandRemoveStreamByProperty'),
          pluginVersion: PLUGIN_VERSION,
          // No `keep_undefined` input exists, and none is needed: the plugin
          // never judges a stream whose property reads undefined, so an
          // untagged track is always kept. Pinned in packages/engine/test/compat.
          inputs: {
            codecType: 'audio',
            propertyToCheck: 'tags.language',
            valuesToRemove: value('keepLanguages'),
            condition: 'not_includes',
          },
        },
        { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'verify',
          pluginId: 'trawlarr:verifyOutput',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            durationToleranceSeconds: '1',
            minSizeRatio: '0.05',
            requireAudioIfOriginalHadAudio: 'true',
          },
        },
        {
          id: 'replace',
          pluginId: 'trawlarr:replaceOriginal',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            trashRetentionDays: value('trashRetentionDays'),
            allowCrossDevice: 'true',
          },
        },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'begin' },
        { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'container' },
        { fromNodeId: 'container', outputNumber: 1, toNodeId: 'check' },
        // Output 1 is "already the target codec". Unlike transcode-hevc it is
        // NOT dead-ended: such a file may still need a remux, a stereo track
        // or a language filter. It rejoins after the encoder, which is the
        // only node it skips. Two edges INTO one node is legal; two edges out
        // of one OUTPUT is not.
        { fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'encoder' },
        { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'muxqueue' },
        { fromNodeId: 'muxqueue', outputNumber: 1, toNodeId: 'audio' },
        { fromNodeId: 'audio', outputNumber: 1, toNodeId: 'language' },
        { fromNodeId: 'language', outputNumber: 1, toNodeId: 'execute' },
        { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
        { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
      ],
    };
  },
};

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [transcodeHevc, conformLibrary];

export const buildFromTemplate = (input: {
  templateId: string;
  values: Record<string, string>;
}): FlowDefinition => {
  const template = FLOW_TEMPLATES.find((candidate) => candidate.id === input.templateId);
  if (template === undefined) {
    throw new UnknownTemplateError(
      input.templateId,
      FLOW_TEMPLATES.map((candidate) => candidate.id),
    );
  }
  return template.build(input.values);
};

/**
 * The flow files shipped in `docs/flows/`, and the template call each one is
 * the output of.
 *
 * They exist because `trawlarr flow add --file` is the path someone follows
 * before they know templates exist (it is what `docs/deployment.md` shows),
 * and a file in the repository is something you can read, diff and edit
 * before you trust it with a library. Keeping them derived from the template
 * rather than hand-written is what stops the two drifting: the shipped file
 * and the built-in template are the same flow, and `templates.test.ts` fails
 * if they ever stop being.
 */
export const SHIPPED_FLOW_FILES: readonly {
  path: string;
  templateId: string;
  values: Record<string, string>;
}[] = [
  {
    path: 'docs/flows/transcode-hevc-cpu.json',
    templateId: 'transcode-hevc',
    values: {
      targetCodec: 'hevc',
      encoder: 'libx265',
      quality: '24',
      trashRetentionDays: '14',
    },
  },
  {
    path: 'docs/flows/transcode-hevc-nvenc.json',
    templateId: 'transcode-hevc',
    // Hardware decoding is ON in the NVENC files and only in those: a file
    // whose name says NVENC is chosen by an operator who has declared that
    // card, and without it the GPU encodes while the CPU decodes every frame
    // — measured at 92.9% user CPU with the encoder at 16-31% on a real
    // library. It is written out in plain text in the flow, so it is a
    // choice the operator can see and remove, not an inference.
    values: {
      targetCodec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: '24',
      trashRetentionDays: '14',
      hardwareDecoding: 'true',
    },
  },
  // The owner's Unmanic pipeline, in both the form this repository can prove
  // end to end (libx265, exercised against real ffmpeg in
  // packages/server/test/plugin-install-end-to-end.test.ts) and the form he
  // actually runs (hevc_nvenc), which needs an NVIDIA card to verify and so
  // is shipped unproven on purpose.
  {
    path: 'docs/flows/conform-mkv-hevc-cpu.json',
    templateId: 'conform-library',
    values: { encoder: 'libx265', quality: '23' },
  },
  {
    path: 'docs/flows/conform-mkv-hevc-nvenc.json',
    templateId: 'conform-library',
    values: { encoder: 'hevc_nvenc', quality: '23', hardwareDecoding: 'true' },
  },
];

/** The exact bytes a shipped flow file must contain. */
export const shippedFlowFileText = (spec: {
  templateId: string;
  values: Record<string, string>;
}): string => `${JSON.stringify(buildFromTemplate(spec), null, 2)}\n`;
