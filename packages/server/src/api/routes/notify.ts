import { mapPath } from '@trawlarr/core';
import { createLibraryRepo } from '../../db/library-repo.js';
import { readArrFolder } from '../../notify/arr-payload.js';
import { libraryContaining, ScopeError, validateScope } from '../../scanner/scope.js';
import { accepted, ApiError, type Route } from '../router.js';

export const notifyRoutes: Route[] = [
  {
    /**
     * Where Sonarr, Radarr and Lidarr post their own webhook, unmodified.
     *
     * A notification is a hint that a folder changed and nothing more: it
     * queues a scan scoped to that folder, and the scan establishes every
     * fact. Nothing durable depends on one arriving — the interval scan
     * finds whatever a lost webhook would have reported.
     */
    method: 'POST',
    path: '/notify/arr',
    handler: ({ body, ctx }) => {
      const read = readArrFolder(body);
      if (read.kind === 'invalid') throw new ApiError(400, 'invalid-body', read.why);
      // Success, not an error: the *arr marks a connection unhealthy on a
      // failed call, and its own Test button sends an event with nothing in
      // it to scan.
      if (read.kind === 'ignore') return { ignored: true, reason: read.why };

      const map = ctx.settings.getScan().notifyPathMap;
      const mapped =
        map.length === 0 ? read.path : (mapPath(map, read.path, 'toServer') ?? read.path);

      const libraries = createLibraryRepo(ctx.db).list();
      const library = libraryContaining(libraries, mapped);
      if (library === undefined) {
        throw new ApiError(
          422,
          'no-library-for-path',
          `No library contains "${mapped}"` +
            (mapped === read.path ? '' : ` (received as "${read.path}")`) +
            `. Library roots: ${libraries.flatMap((candidate) => candidate.roots).join(', ') || 'none'}. ` +
            `If the sending application sees the library at a different path, set "Notification paths".`,
        );
      }

      let paths: string[];
      try {
        paths = validateScope({ library, paths: [mapped], lexical: true });
      } catch (error) {
        if (error instanceof ScopeError) throw new ApiError(422, 'invalid-scope', error.message);
        throw error;
      }
      ctx.scans.request(library.id, 'notify', paths);
      return accepted({ accepted: true, libraryId: library.id, path: paths[0] });
    },
  },
];
