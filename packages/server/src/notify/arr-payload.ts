/**
 * What a Sonarr, Radarr or Lidarr webhook says to scan.
 *
 * ONE VALUE IS READ: the folder of the series, movie or artist. The payloads
 * name FILES in different fields for import, upgrade, rename and delete, and
 * differently per application, but every one of them carries that folder —
 * so a scan scoped to it covers every event with one rule, and re-checking a
 * folder that did not change changes nothing.
 *
 * Unknown event types are scanned, not refused. The list of events is the
 * *arrs' to grow, and refusing a new one would turn an upgrade of Sonarr
 * into imports nobody scans.
 */
export type ArrFolder =
  | { kind: 'folder'; path: string }
  /** Understood, and nothing to scan. Answered with success. */
  | { kind: 'ignore'; why: string }
  /** Not something this endpoint can act on. Answered with a client error. */
  | { kind: 'invalid'; why: string };

/** Events that name a folder nothing has happened in yet, or a placeholder one. */
const IGNORED_EVENTS: ReadonlySet<string> = new Set(['Test', 'Grab']);

const fieldOf = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

export const readArrFolder = (body: unknown): ArrFolder => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid', why: 'The body is not a JSON object.' };
  }

  const eventType = fieldOf(body, 'eventType');
  if (typeof eventType === 'string' && IGNORED_EVENTS.has(eventType)) {
    return { kind: 'ignore', why: `"${eventType}" events name nothing to scan.` };
  }

  const folder =
    fieldOf(fieldOf(body, 'series'), 'path') ??
    fieldOf(fieldOf(body, 'movie'), 'folderPath') ??
    fieldOf(fieldOf(body, 'artist'), 'path');
  if (folder === undefined || folder === null) {
    return { kind: 'ignore', why: 'The event names no series, movie or artist folder.' };
  }
  if (typeof folder !== 'string') {
    return { kind: 'invalid', why: `The folder is not a string: ${JSON.stringify(folder)}.` };
  }
  if (!folder.startsWith('/')) {
    return {
      kind: 'invalid',
      why:
        `The folder "${folder}" is not an absolute POSIX path. trawlarr reads the path as the ` +
        `sending application reports it; map it with the "Notification paths" setting.`,
    };
  }
  return { kind: 'folder', path: folder };
};
