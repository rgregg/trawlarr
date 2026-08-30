import { ApiClientError } from '../../api/client.js';

export interface LibraryDraft {
  name: string;
  roots: string;
  extensions: string;
  allowHardlinked: boolean;
}

export interface LibraryCreateBody {
  name: string;
  roots: string[];
  extensions?: string[];
  allowHardlinked?: boolean;
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
      'Roots must be absolute paths as the trawlarr process sees them — in Docker that is the ' +
        'path inside the container, e.g. /library/movies, not the host path.',
    );
  }
  return problems;
};

export const toCreateBody = (draft: LibraryDraft): LibraryCreateBody => {
  const extensions = split(draft.extensions);
  return {
    name: draft.name.trim(),
    roots: split(draft.roots),
    // OMITTED when blank, never sent as []: an empty array means "match
    // nothing", which scans as a permanently empty library with no error.
    ...(extensions.length > 0 ? { extensions } : {}),
    allowHardlinked: draft.allowHardlinked,
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
      title: 'trawlarr refused this',
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  return {
    title: 'Could not reach trawlarr',
    message:
      'The daemon did not answer. It may be restarting, or this page may have been left open ' +
      'after it stopped.',
    retryable: true,
  };
};
