import { existsSync, readFileSync } from 'node:fs';
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
    // Hardware DECODING is off unless it was asked for, even when the encoder
    // is a GPU one: the operator declares hardware, trawlarr never infers it,
    // and a node that decodes on a device the machine has not got fails every
    // file rather than falling back.
    expect(encoder.inputs).toEqual({
      encoder: 'hevc_nvenc',
      quality: '22',
      hardwareDecoding: 'false',
    });
    const check = definition.nodes.find((node) => node.id === 'check')!;
    expect(check.inputs).toEqual({ codec: 'hevc' });
    const replace = definition.nodes.find((node) => node.id === 'replace')!;
    expect(replace.inputs).toEqual({ trashRetentionDays: '7', allowCrossDevice: 'true' });
  });

  it('passes hardware decoding through to the encoder node only when it is asked for', () => {
    const inputsFor = (hardwareDecoding: string): Record<string, unknown> =>
      buildFromTemplate({
        templateId: 'transcode-hevc',
        values: { encoder: 'hevc_nvenc', hardwareDecoding },
      }).nodes.find((node) => node.id === 'encoder')!.inputs;

    expect(inputsFor('true').hardwareDecoding).toBe('true');
    // The default is the one that matters: an existing library that upgrades
    // into this must keep emitting exactly the command it emitted yesterday.
    expect(inputsFor('').hardwareDecoding).toBe('false');
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
      hardwareDecoding: 'false',
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
      values: { encoder: '', quality: '', targetCodec: '', hardwareDecoding: '' },
    });
    expect(definition.nodes.find((node) => node.id === 'encoder')!.inputs).toEqual({
      encoder: 'libx265',
      quality: '24',
      hardwareDecoding: 'false',
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
  it('ships a CPU and an NVENC form of both the transcode and the conform stack', () => {
    expect(SHIPPED_FLOW_FILES.map((file) => file.path)).toEqual([
      'docs/flows/transcode-hevc-cpu.json',
      'docs/flows/transcode-hevc-nvenc.json',
      'docs/flows/conform-mkv-hevc-cpu.json',
      'docs/flows/conform-mkv-hevc-nvenc.json',
    ]);
  });

  it('docs/flows/conform-mkv-hevc-nvenc.json matches what the template builds', () => {
    const path = `${repoRoot}docs/flows/conform-mkv-hevc-nvenc.json`;
    // Assert the path EXISTS rather than gating on it: gating on existsSync
    // makes a renamed fixture skip silently, which makes a drift alarm green.
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
      buildFromTemplate({
        templateId: 'conform-library',
        // The NVENC file is the one that ships with hardware decoding on.
        values: { encoder: 'hevc_nvenc', quality: '23', hardwareDecoding: 'true' },
      }),
    );
  });

  it('docs/flows/conform-mkv-hevc-cpu.json matches what the template builds', () => {
    const path = `${repoRoot}docs/flows/conform-mkv-hevc-cpu.json`;
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
      buildFromTemplate({
        templateId: 'conform-library',
        values: { encoder: 'libx265', quality: '23' },
      }),
    );
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
    expect(encoderOf('docs/flows/conform-mkv-hevc-cpu.json')).toBe('libx265');
    expect(encoderOf('docs/flows/conform-mkv-hevc-nvenc.json')).toBe('hevc_nvenc');
  });
});

describe('the conform-library template', () => {
  const build = (values: Record<string, string> = {}) =>
    buildFromTemplate({ templateId: 'conform-library', values });

  it('declares the community plugins it needs, so a fresh install is told to sync', () => {
    const template = FLOW_TEMPLATES.find((t) => t.id === 'conform-library')!;
    expect(template.requiredPlugins).toEqual([
      'ffmpegCommandSetContainer',
      'ffmpegCommandCustomArguments',
      'ffmpegCommandEnsureAudioStream',
      'ffmpegCommandRemoveStreamByProperty',
    ]);
  });

  it('carries his exact encoder settings into the node inputs', () => {
    const flow = build({ encoder: 'hevc_nvenc', quality: '23' });
    const encoder = flow.nodes.find((n) => n.id === 'encoder')!;
    expect(encoder.inputs).toMatchObject({ encoder: 'hevc_nvenc', quality: '23' });
  });

  it('carries -max_muxing_queue_size 2048 as a custom argument, with no preset by default', () => {
    const flow = build();
    const custom = flow.nodes.find((n) => n.id === 'muxqueue')!;
    // No preset by default: preset names are encoder-specific (nvenc takes
    // p1..p7, libx265 takes ultrafast..placebo), so a default that suits one
    // encoder is an invalid argument for the other and fails every job.
    expect(custom.inputs.outputArguments).toBe('-max_muxing_queue_size 2048');
  });

  it('appends a preset only when one was asked for', () => {
    const flow = build({ preset: 'p4' });
    const custom = flow.nodes.find((n) => n.id === 'muxqueue')!;
    expect(custom.inputs.outputArguments).toBe('-max_muxing_queue_size 2048 -preset p4');
  });

  it('defaults the destination container to mkv', () => {
    expect(build().nodes.find((n) => n.id === 'container')!.inputs.container).toBe('mkv');
  });

  it('keeps English audio and never removes an untagged track', () => {
    const remove = build().nodes.find((n) => n.id === 'language')!;
    expect(remove.inputs).toMatchObject({
      codecType: 'audio',
      propertyToCheck: 'tags.language',
      valuesToRemove: 'eng',
      condition: 'not_includes',
    });
    // keep_undefined needs no input: the plugin never judges a stream whose
    // property is absent. Pinned in packages/engine/test/compat.
  });

  it('leaves the already-target-codec output of the check node routed onward, not dead-ended', () => {
    // Unlike transcode-hevc, a converged-codec file may still need a remux,
    // an audio track or a language filter — so output 1 rejoins the chain
    // rather than ending the flow.
    const flow = build();
    const fromCheck = flow.edges.filter((e) => e.fromNodeId === 'check');
    expect(fromCheck.map((e) => e.outputNumber).sort()).toEqual([1, 2]);
  });

  it('names every community node with the source the user chose', () => {
    const flow = build({ pluginSource: 'mine' });
    const communityIds = flow.nodes
      .map((node) => node.pluginId)
      .filter((id) => !id.startsWith('trawlarr:'));
    expect(communityIds).toEqual([
      'mine:ffmpegCommandSetContainer',
      'mine:ffmpegCommandCustomArguments',
      'mine:ffmpegCommandEnsureAudioStream',
      'mine:ffmpegCommandRemoveStreamByProperty',
    ]);
  });

  it('validates', () => {
    const problems = validateFlowDefinition(build(), () => null);
    expect(problems).toEqual([]);
  });
});
