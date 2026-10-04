import { ApiClientError } from '../../api/client.js';

export interface LibraryDraft {
  name: string;
  roots: string;
  extensions: string;
  allowHardlinked: boolean;
  stagingDir: string;
  plexUrl: string;
  plexToken: string;
  plexSectionId: string;
  plexPathPrefix: string;
  runtimeKind: '' | 'radarr' | 'sonarr';
  runtimeUrl: string;
  /** Blank keeps the stored key: the daemon never sends it back. */
  runtimeApiKey: string;
  runtimePercent: string;
  runtimeMinutes: string;
}

/** What the daemon stores for a library's media-server notification. */
export interface PlexPatch {
  url: string;
  token: string;
  sectionId: string;
  pathPrefix: string | null;
}

export interface RuntimePatch {
  kind: 'radarr' | 'sonarr' | null;
  url: string;
  apiKey?: string;
  percent: number;
  minutes: number;
}

export interface LibraryCreateBody {
  name: string;
  roots: string[];
  extensions?: string[];
  allowHardlinked?: boolean;
  stagingDir?: string | null;
}

const split = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export const draftProblems = (draft: LibraryDraft): string[] => {
  const problems: string[] = [];
  if (draft.name.trim() === '') problems.push('Give the library a name.');

  const roots = split(draft.roots);
  if (roots.length === 0) {
    problems.push(
      'Give the library at least one root directory: a library with no root has nothing to scan.',
    );
  } else if (roots.some((root) => !root.startsWith('/'))) {
    // The daemon rejects this too. Naming it here is worth the duplication,
    // because in a container the tempting value is the HOST path and the
    // correct one is the container path — a distinction a 400 does not teach.
    problems.push(
      'Roots must be absolute paths as the Trawlarr process sees them — in Docker that is the ' +
        'path inside the container, e.g. /library/movies, not the host path.',
    );
  }

  const staging = draft.stagingDir.trim();
  if (staging !== '' && !staging.startsWith('/')) {
    problems.push(
      'Staging directory must be an absolute path as the Trawlarr process sees it — in Docker ' +
        'that is the path inside the container, e.g. /cache/staging, not the host path.',
    );
  }

  const plexUrl = draft.plexUrl.trim();
  if (plexUrl !== '' && !/^https?:\/\//.test(plexUrl)) {
    problems.push('Plex URL needs a scheme, e.g. http://plex.lan:32400.');
  }
  if (plexUrl !== '' && draft.plexSectionId.trim() === '') {
    problems.push('Give the Plex library number, from the section URL in Plex.');
  }
  const plexPath = draft.plexPathPrefix.trim();
  if (plexPath !== '' && !plexPath.startsWith('/')) {
    // Plex answers 200 for a path outside the section and scans nothing, so a
    // wrong value here is a notification that succeeds and does nothing.
    problems.push('Plex library path must be absolute, as Plex sees it, e.g. /data/movies.');
  }

  const runtimeUrl = draft.runtimeUrl.trim();
  if (draft.runtimeKind !== '' && !/^https?:\/\//.test(runtimeUrl)) {
    problems.push('Radarr/Sonarr URL needs a scheme, e.g. http://radarr.lan:7878.');
  }
  for (const [label, raw, max] of [
    ['Length tolerance %', draft.runtimePercent, 100],
    ['Length tolerance minutes', draft.runtimeMinutes, 600],
  ] as const) {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || value > max) {
      problems.push(`${label} must be a number from 0 to ${String(max)}.`);
    }
  }

  return problems;
};

/**
 * The `runtime` field of an edit. No source (kind empty) clears the address
 * and key; otherwise a blank key is OMITTED so the stored one survives.
 */
export const toRuntimePatch = (draft: LibraryDraft): RuntimePatch => {
  const apiKey = draft.runtimeApiKey.trim();
  const base = { percent: Number(draft.runtimePercent), minutes: Number(draft.runtimeMinutes) };
  if (draft.runtimeKind === '') return { kind: null, url: '', apiKey: '', ...base };
  return {
    kind: draft.runtimeKind,
    url: draft.runtimeUrl.trim(),
    ...(apiKey === '' ? {} : { apiKey }),
    ...base,
  };
};

/**
 * The `plex` field of an edit: null turns notification off, which is what an
 * emptied URL means. Never sent on create — a section number can only be read
 * out of Plex once the library exists, so the fields are shown on edit only.
 */
export const toPlexPatch = (draft: LibraryDraft): PlexPatch | null => {
  const url = draft.plexUrl.trim();
  if (url === '') return null;
  const pathPrefix = draft.plexPathPrefix.trim();
  return {
    url,
    token: draft.plexToken.trim(),
    sectionId: draft.plexSectionId.trim(),
    pathPrefix: pathPrefix === '' ? null : pathPrefix,
  };
};

export const toCreateBody = (draft: LibraryDraft): LibraryCreateBody => {
  const extensions = split(draft.extensions);
  const staging = draft.stagingDir.trim();
  return {
    name: draft.name.trim(),
    roots: split(draft.roots),
    // OMITTED when blank, never sent as []: an empty array means "match
    // nothing", which scans as a permanently empty library with no error.
    ...(extensions.length > 0 ? { extensions } : {}),
    allowHardlinked: draft.allowHardlinked,
    ...(staging !== '' ? { stagingDir: staging } : { stagingDir: null }),
  };
};

/**
 * Turn a failure into something worth showing.
 *
 * A refusal the daemon wrote is passed through VERBATIM. Those messages were
 * composed for a reader and name the consequence — "resuming would hand every
 * file to a flow that fails on all of them" is the diagnosis, and replacing it
 * with "Could not resume library" throws the diagnosis away.
 */
export const describeFailure = (
  error: unknown,
): { title: string; message: string; retryable: boolean } => {
  if (error instanceof ApiClientError) {
    return {
      title: 'Trawlarr refused this',
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  return {
    title: 'Could not reach Trawlarr',
    message:
      'The daemon did not answer. It may be restarting, or this page may have been left open ' +
      'after it stopped.',
    retryable: true,
  };
};
