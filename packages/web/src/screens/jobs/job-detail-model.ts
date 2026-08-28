/**
 * A job's steps, with the engine's own sentences kept intact.
 *
 * `Running ffmpeg: <reasons>` and `Skipping ffmpeg: <reason>` are the most
 * useful strings this system produces — they name the exact argument or
 * stream that made a file worth rewriting. This module's only real job is to
 * carry them to the screen unshortened.
 */
export interface ApiStep {
  seq: number;
  pluginId: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string | null;
}

export interface StepRow {
  seq: number;
  label: string;
  outcome: 'ok' | 'failed' | 'running';
  durationMs: number;
  reason: string | null;
}

export const pluginLabel = (pluginId: string): string => {
  const name = pluginId.includes(':') ? pluginId.slice(pluginId.indexOf(':') + 1) : pluginId;
  if (!/[a-z][A-Z]/.test(name) && name === name.toLowerCase())
    return pluginId.includes(':') ? capitalise(name) : name;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .map(capitalise)
    .join(' ');
};

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Output 2 is the failure branch by convention throughout the flow contract. */
export const toStepRows = (steps: ApiStep[]): StepRow[] =>
  steps.map((step) => ({
    seq: step.seq,
    label: pluginLabel(step.pluginId),
    outcome: step.outputNumber === null ? 'running' : step.outputNumber === 2 ? 'failed' : 'ok',
    durationMs: step.durationMs,
    reason: step.logExcerpt,
  }));
