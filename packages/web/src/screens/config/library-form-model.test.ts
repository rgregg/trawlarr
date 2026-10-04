import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../api/client.js';
import {
  describeFailure,
  draftProblems,
  toCreateBody,
  toPlexPatch,
  toRuntimePatch,
  type LibraryDraft,
} from './library-form-model.js';

const draft = (patch: Partial<LibraryDraft> = {}): LibraryDraft => ({
  name: 'Movies',
  roots: '/library/movies',
  extensions: 'mkv, mp4',
  allowHardlinked: false,
  stagingDir: '',
  plexUrl: '',
  plexToken: '',
  plexSectionId: '',
  plexPathPrefix: '',
  runtimeKind: '',
  runtimeUrl: '',
  runtimeApiKey: '',
  runtimePercent: '5',
  runtimeMinutes: '3',
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
      'Roots must be absolute paths as the Trawlarr process sees them — in Docker that is the ' +
        'path inside the container, e.g. /library/movies, not the host path.',
    );
  });

  it('rejects a relative staging directory before the request is sent', () => {
    expect(draftProblems(draft({ stagingDir: 'cache/staging' }))).toContain(
      'Staging directory must be an absolute path as the Trawlarr process sees it — in Docker ' +
        'that is the path inside the container, e.g. /cache/staging, not the host path.',
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
      stagingDir: null,
    });
  });

  it('includes trimmed stagingDir when provided', () => {
    expect(toCreateBody(draft({ stagingDir: '  /cache/ssd-staging  ' })).stagingDir).toBe(
      '/cache/ssd-staging',
    );
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
      title: 'Trawlarr refused this',
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
      title: 'Could not reach Trawlarr',
      message:
        'The daemon did not answer. It may be restarting, or this page may have been left open ' +
        'after it stopped.',
      retryable: true,
    });
  });
});

describe('plex notification', () => {
  it('is off when no URL is given', () => {
    expect(toPlexPatch(draft())).toBeNull();
  });

  it('carries the four fields, with an empty library path meaning whole-section', () => {
    expect(
      toPlexPatch(
        draft({
          plexUrl: ' http://plex.lan:32400 ',
          plexToken: 'tok',
          plexSectionId: ' 2 ',
          plexPathPrefix: '',
        }),
      ),
    ).toEqual({
      url: 'http://plex.lan:32400',
      token: 'tok',
      sectionId: '2',
      pathPrefix: null,
    });
  });

  it('asks for a scheme rather than letting a host:port through', () => {
    expect(draftProblems(draft({ plexUrl: 'plex.lan:32400', plexSectionId: '2' }))).toContain(
      'Plex URL needs a scheme, e.g. http://plex.lan:32400.',
    );
  });

  it('asks for the section number once a URL is given', () => {
    expect(draftProblems(draft({ plexUrl: 'http://plex.lan:32400' }))).toContain(
      'Give the Plex library number, from the section URL in Plex.',
    );
  });

  it('rejects a relative Plex library path, which Plex would silently ignore', () => {
    expect(
      draftProblems(
        draft({
          plexUrl: 'http://plex.lan:32400',
          plexSectionId: '2',
          plexPathPrefix: 'data/movies',
        }),
      ),
    ).toContain('Plex library path must be absolute, as Plex sees it, e.g. /data/movies.');
  });

  it('leaves a draft with no Plex fields entirely clean', () => {
    expect(draftProblems(draft())).toEqual([]);
  });
});

describe('expected length settings', () => {
  it('needs a URL with a scheme once a source is chosen', () => {
    expect(draftProblems(draft({ runtimeKind: 'radarr', runtimeUrl: 'radarr.lan' }))).toContain(
      'Radarr/Sonarr URL needs a scheme, e.g. http://radarr.lan:7878.',
    );
    expect(
      draftProblems(draft({ runtimeKind: 'radarr', runtimeUrl: 'http://radarr.lan:7878' })),
    ).toEqual([]);
  });

  it('rejects a tolerance that is not a number in range', () => {
    expect(draftProblems(draft({ runtimePercent: '' }))).toHaveLength(1);
    expect(draftProblems(draft({ runtimePercent: '101' }))).toHaveLength(1);
    expect(draftProblems(draft({ runtimeMinutes: 'x' }))).toHaveLength(1);
  });

  it('omits a blank API key so the stored one survives', () => {
    const patch = toRuntimePatch(
      draft({ runtimeKind: 'sonarr', runtimeUrl: ' http://s:8989 ', runtimePercent: '10' }),
    );
    expect(patch).toEqual({ kind: 'sonarr', url: 'http://s:8989', percent: 10, minutes: 3 });
    expect('apiKey' in patch).toBe(false);
    expect(toRuntimePatch(draft({ runtimeKind: 'sonarr', runtimeApiKey: 'k' })).apiKey).toBe('k');
  });

  it('clears the address and key when no source is chosen', () => {
    expect(toRuntimePatch(draft())).toEqual({
      kind: null,
      url: '',
      apiKey: '',
      percent: 5,
      minutes: 3,
    });
  });
});
