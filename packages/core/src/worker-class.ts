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
