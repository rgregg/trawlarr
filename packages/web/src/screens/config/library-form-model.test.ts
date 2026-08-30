import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../api/client.js';
import {
  describeFailure,
  draftProblems,
  toCreateBody,
  type LibraryDraft,
} from './library-form-model.js';

const draft = (patch: Partial<LibraryDraft> = {}): LibraryDraft => ({
  name: 'Movies',
  roots: '/library/movies',
  extensions: 'mkv, mp4',
  allowHardlinked: false,
  ...patch,
});

describe('draftProblems', () => {
  it('accepts a well-formed draft', () => {
    expect(draftProblems(draft())).toEqual([]);
  });

  it('requires a name and at least one root', () => {
    expect(draftProblems(draft({ name: '  ' }))).toContain('Give the library a name.');
    expect(draftProblems(draft({ roots: '' }))).toContain(
      'Give the library at least one root directory: a library with no root has nothing to scan.',
    );
  });

  it('rejects a relative root before the request is sent', () => {
    // The daemon rejects this too, but a container makes it easy to type a
    // host path that is not the container's path — so the form names it
    // rather than round-tripping a 400.
    expect(draftProblems(draft({ roots: 'media/movies' }))).toContain(
      'Roots must be absolute paths as the trawlarr process sees them — in Docker that is the ' +
        'path inside the container, e.g. /library/movies, not the host path.',
    );
  });
});

describe('toCreateBody', () => {
  it('splits roots and extensions and drops empty entries', () => {
    expect(toCreateBody(draft({ roots: '/a\n/b\n\n', extensions: 'mkv, mp4, ' }))).toEqual({
      name: 'Movies',
      roots: ['/a', '/b'],
      extensions: ['mkv', 'mp4'],
      allowHardlinked: false,
    });
  });

  it('omits extensions entirely when the field is blank, rather than sending []', () => {
    // An empty array would mean "match nothing"; omitting it keeps the
    // daemon's default.
    expect(toCreateBody(draft({ extensions: '   ' })).extensions).toBeUndefined();
  });
});

describe('describeFailure', () => {
  it('passes the daemon’s own message through for a rejection it wrote', () => {
    const error = new ApiClientError({
      status: 409,
      code: 'overlapping-roots',
      message: 'Root "/library" overlaps library "TV".',
    });
    expect(describeFailure(error)).toEqual({
      title: 'trawlarr refused this',
      message: 'Root "/library" overlaps library "TV".',
      retryable: false,
    });
  });

  it('marks a 500 as retryable and does not invent a cause', () => {
    const error = new ApiClientError({
      status: 500,
      code: 'internal-error',
      message: 'The daemon failed.',
    });
    expect(describeFailure(error).retryable).toBe(true);
  });

  it('describes a lost connection as a connection problem', () => {
    expect(describeFailure(new TypeError('Failed to fetch'))).toEqual({
      title: 'Could not reach trawlarr',
      message:
        'The daemon did not answer. It may be restarting, or this page may have been left open ' +
        'after it stopped.',
      retryable: true,
    });
  });
});
