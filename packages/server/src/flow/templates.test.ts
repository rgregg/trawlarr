import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFlowDefinition } from '@trawlarr/core';
import { describe, expect, it } from 'vitest';
import { createNodeCapabilityResolver } from './node-capabilities.js';
import {
  buildFromTemplate,
  FLOW_TEMPLATES,
  SHIPPED_FLOW_FILES,
  shippedFlowFileText,
  UnknownTemplateError,
} from './templates.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('FLOW_TEMPLATES', () => {
  it('includes the Unmanic-equivalent transcode stack', () => {
    expect(FLOW_TEMPLATES.map((template) => template.id)).toContain('transcode-hevc');
  });

  it.each(FLOW_TEMPLATES.map((template) => template.id))(
    'template %s builds a definition the executor will accept, with its defaults',
    (id) => {
      const template = FLOW_TEMPLATES.find((candidate) => candidate.id === id)!;
      const values = Object.fromEntries(
        template.parameters.map((p) => [p.name, p.defaultValue] as const),
      );
      const problems = validateFlowDefinition(
        buildFromTemplate({ templateId: id, values }),
        createNodeCapabilityResolver(),
      );
      // A template that produces an invalid flow is worse than no template:
      // it pauses the library it is attached to, with a reason naming a node
      // the user never chose.
      expect(problems).toEqual([]);
    },
  );

  /**
   * Every option a parameter offers, not just its default. The dropdown is a
   * promise that any of those values is a flow trawlarr will run, and an
   * option that only validated when it happened to be the default is a
   * promise broken by whoever picks the second entry.
   */
  it.each(
    FLOW_TEMPLATES.flatMap((template) =>
      template.parameters.flatMap((parameter) =>
        (parameter.options ?? []).map(
          (option) => [template.id, parameter.name, option] as [string, string, string],
        ),
      ),
    ),
  )('template %s stays valid with %s=%s', (templateId, name, option) => {
    const problems = validateFlowDefinition(
      buildFromTemplate({ templateId, values: { [name]: option } }),
      createNodeCapabilityResolver(),
    );
    expect(problems).toEqual([]);
  });

  it('puts the chosen encoder and quality into the Set Video Encoder node', () => {
    const definition = buildFromTemplate({
      templateId: 'transcode-hevc',
      values: {
        targetCodec: 'hevc',
        encoder: 'hevc_nvenc',
        quality: '22',
        trashRetentionDays: '7',
      },
    });
    const encoder = definition.nodes.find((node) => node.id === 'encoder')!;
    expect(encoder.inputs).toEqual({ encoder: 'hevc_nvenc', quality: '22' });
    const check = definition.nodes.find((node) => node.id === 'check')!;
    expect(check.inputs).toEqual({ codec: 'hevc' });
    const replace = definition.nodes.find((node) => node.id === 'replace')!;
    expect(replace.inputs).toEqual({ trashRetentionDays: '7', allowCrossDevice: 'true' });
  });

  it('routes an already-converged file to nothing, and a mismatched one to the transcode', () => {
    const definition = buildFromTemplate({
      templateId: 'transcode-hevc',
      values: { targetCodec: 'hevc', encoder: 'libx265', quality: '24', trashRetentionDays: '14' },
    });
    // Check Video Codec output 1 is "already this codec" and MUST be a dead
    // end: an edge there would transcode files that are already correct, for
    // ever. Output 2 is "differs" and is the working path.
    expect(definition.edges.filter((edge) => edge.fromNodeId === 'check')).toEqual([
      { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
    ]);
  });

  it('refuses an unknown template by name', () => {
    expect(() => buildFromTemplate({ templateId: 'nope', values: {} })).toThrow(
      UnknownTemplateError,
    );
  });

  it('falls back to a parameter default rather than emitting an empty input', () => {
    const definition = buildFromTemplate({ templateId: 'transcode-hevc', values: {} });
    expect(definition.nodes.find((node) => node.id === 'encoder')!.inputs).toEqual({
      encoder: 'libx265',
      quality: '24',
    });
  });

  /**
   * `--set quality=` and an untouched form field both arrive as `''`. Passing
   * that through would write `"quality": ""` into the node — a flow that
   * validates (validation checks the graph, not the inputs) and then hands
   * ffmpeg `-crf ''` on the first file that reaches it.
   */
  it('treats an empty value as absent rather than as a chosen one', () => {
    const definition = buildFromTemplate({
      templateId: 'transcode-hevc',
      values: { encoder: '', quality: '', targetCodec: '' },
    });
    expect(definition.nodes.find((node) => node.id === 'encoder')!.inputs).toEqual({
      encoder: 'libx265',
      quality: '24',
    });
    expect(definition.nodes.find((node) => node.id === 'check')!.inputs).toEqual({ codec: 'hevc' });
  });
});

/**
 * The flow files in `docs/flows/` are what someone loads with
 * `trawlarr flow add --file` before they have heard of templates. They are
 * generated from the template, so this suite is what keeps them from
 * drifting into a hand-edited flow nobody validates.
 */
describe('the flow files shipped in docs/flows', () => {
  it('ships both the CPU and the NVENC form', () => {
    expect(SHIPPED_FLOW_FILES.map((file) => file.path)).toEqual([
      'docs/flows/transcode-hevc-cpu.json',
      'docs/flows/transcode-hevc-nvenc.json',
    ]);
  });

  it.each(SHIPPED_FLOW_FILES.map((file) => file.path))(
    '%s is on disk, byte-identical to the template that generates it',
    (path) => {
      const spec = SHIPPED_FLOW_FILES.find((candidate) => candidate.path === path)!;
      expect(readFileSync(`${repoRoot}${path}`, 'utf8')).toBe(shippedFlowFileText(spec));
    },
  );

  it.each(SHIPPED_FLOW_FILES.map((file) => file.path))(
    '%s parses and is a flow trawlarr will run',
    (path) => {
      const parsed = JSON.parse(readFileSync(`${repoRoot}${path}`, 'utf8')) as Parameters<
        typeof validateFlowDefinition
      >[0];
      expect(validateFlowDefinition(parsed, createNodeCapabilityResolver())).toEqual([]);
    },
  );

  it('names the encoder each form exists for', () => {
    const encoderOf = (path: string): unknown =>
      (
        JSON.parse(readFileSync(`${repoRoot}${path}`, 'utf8')) as {
          nodes: { id: string; inputs: Record<string, unknown> }[];
        }
      ).nodes.find((node) => node.id === 'encoder')!.inputs.encoder;

    expect(encoderOf('docs/flows/transcode-hevc-cpu.json')).toBe('libx265');
    expect(encoderOf('docs/flows/transcode-hevc-nvenc.json')).toBe('hevc_nvenc');
  });
});
