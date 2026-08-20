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
          inputs: { encoder: value('encoder'), quality: value('quality') },
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

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [transcodeHevc];

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
    values: {
      targetCodec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: '24',
      trashRetentionDays: '14',
    },
  },
];

/** The exact bytes a shipped flow file must contain. */
export const shippedFlowFileText = (spec: {
  templateId: string;
  values: Record<string, string>;
}): string => `${JSON.stringify(buildFromTemplate(spec), null, 2)}\n`;
