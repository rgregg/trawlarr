/**
 * Trawlarr keeps a class x hardware model internally (spec §4.4): a
 * `WorkerClass` says WHAT KIND of work a worker does, and a `HardwareType`
 * says what it runs on, because hardware carries its own concurrency cap
 * independent of pool size — "six transcode workers, at most two using
 * NVENC" has to be directly expressible. Tdarr's flat `transcodecpu` /
 * `transcodegpu` namespace cannot express that, so it is projected onto this
 * split only at the plugin boundary (`tdarrWorkerType`, Task 3 of the P2b
 * daemon phase) rather than the other way around.
 *
 * `health` is a class with no queue in this phase (health-check nodes are
 * v1.1) — declared here because the type needs to exist, not because
 * anything schedules against it yet.
 *
 * These two declarations are pulled forward from Task 3 of
 * docs/superpowers/plans/2026-08-18-p2b-daemon.md so the settings repository
 * (Task 1) can import `HardwareType` without a forward reference. The
 * projection helpers (`tdarrWorkerType`, `flowRequiredHardware`,
 * `hardwareForEncoder`) are intentionally left for that task.
 */
import type { FlowDefinition, FlowNode } from './flow.js';

export type WorkerClass = 'transcode' | 'health';

export const WORKER_CLASSES: readonly WorkerClass[] = ['transcode', 'health'];

/**
 * Hardware is DECLARED by the operator, never detected — nothing in this
 * codebase probes for a GPU. Declaring a type here that the host doesn't
 * actually have produces failing jobs, exactly as it would in Tdarr.
 */
export type HardwareType = 'cpu' | 'nvenc' | 'qsv' | 'vaapi' | 'videotoolbox' | 'amf';

export const HARDWARE_TYPES: readonly HardwareType[] = [
  'cpu',
  'nvenc',
  'qsv',
  'vaapi',
  'videotoolbox',
  'amf',
];

const GPU_HARDWARE: ReadonlySet<HardwareType> = new Set([
  'nvenc',
  'qsv',
  'vaapi',
  'videotoolbox',
  'amf',
]);

/**
 * Projects our class x hardware split onto the flat string a Tdarr-compatible
 * plugin reads from `args.workerType`. This is the ONLY place that string is
 * produced — everywhere else in trawlarr keeps class and hardware separate.
 */
export const tdarrWorkerType = (input: {
  workerClass: WorkerClass;
  hardwareType: HardwareType;
}): string => {
  const suffix = GPU_HARDWARE.has(input.hardwareType) ? 'gpu' : 'cpu';
  return input.workerClass === 'health' ? `healthcheck${suffix}` : `transcode${suffix}`;
};

const ENCODER_SUFFIXES: ReadonlyArray<[string, HardwareType]> = [
  ['_nvenc', 'nvenc'],
  ['_qsv', 'qsv'],
  ['_vaapi', 'vaapi'],
  ['_videotoolbox', 'videotoolbox'],
  ['_amf', 'amf'],
];

/** Maps an ffmpeg encoder name onto the hardware family it needs, defaulting to 'cpu'. */
export const hardwareForEncoder = (encoder: string): HardwareType =>
  ENCODER_SUFFIXES.find(([suffix]) => encoder.endsWith(suffix))?.[1] ?? 'cpu';

const isEncoderInputKey = (key: string): boolean => key === 'encoder' || key.endsWith('Encoder');

const encoderNamesInNode = (node: FlowNode): string[] =>
  Object.entries(node.inputs)
    .filter(([key, value]) => isEncoderInputKey(key) && typeof value === 'string')
    .map(([, value]) => value as string);

/**
 * The hardware a flow's encoder settings require, derived fresh from the flow
 * every time rather than stored — a flow edit changes the requirement the
 * instant it changes the flow, with nothing to fall out of sync. Empty means
 * "any node can run it". Only input keys named `encoder` or ending in
 * `Encoder` are consulted, never arbitrary string values, so an unrelated
 * tooltip mentioning a hardware name cannot invent a requirement.
 */
export const flowRequiredHardware = (flow: FlowDefinition): HardwareType[] => {
  const required = new Set<HardwareType>();
  for (const node of flow.nodes) {
    for (const encoder of encoderNamesInNode(node)) {
      const hardware = hardwareForEncoder(encoder);
      if (hardware !== 'cpu') required.add(hardware);
    }
  }
  return HARDWARE_TYPES.filter((type) => required.has(type));
};
