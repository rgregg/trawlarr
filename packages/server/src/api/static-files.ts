import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, pathContains } from '../fs/path-contains.js';
import { API_PREFIX } from './router.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const NOT_BUILT = JSON.stringify({
  error: {
    code: 'web-ui-not-built',
    message:
      'The web UI is not present in this installation. The Docker image ships it; a source ' +
      'checkout builds it with "pnpm build". The REST API at /api/v1 is unaffected and the ' +
      '"trawlarr" CLI works exactly as before.',
  },
});

/**
 * Where the built bundle lives, or `null` if it was never built.
 *
 * Two candidates, in order: the path handed in (the image sets it), then
 * `@trawlarr/web`'s `dist` relative to this file in a source checkout. `null`
 * rather than a throw, because a headless install that never wants a UI is a
 * legitimate deployment and must still start.
 */
export const resolveWebRoot = (input?: { override?: string }): string | null => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    input?.override,
    // From `packages/server/{src,dist}/api` in a source checkout.
    resolve(here, '../../../web/dist'),
    // From `/app/dist/api` in the image, where the bundle is `/app/web/dist`.
    resolve(here, '../../web/dist'),
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
};

/**
 * Serve the single-page bundle, and NOTHING under {@link API_PREFIX}.
 *
 * The API-prefix check comes first and is unconditional: a bundle that
 * happened to contain a file called `api` would otherwise shadow the entire
 * REST surface, and the failure would look like the daemon losing its
 * endpoints. Unknown paths fall back to `index.html` because client-side
 * routes are not files; a request for a path that LOOKS like an asset (it
 * has an extension) 404s instead, so a missing chunk is reported as missing
 * rather than served an HTML page the browser cannot parse as JavaScript.
 */
export const createStaticHandler = (input: {
  root: string | null;
}): ((req: IncomingMessage, res: ServerResponse) => boolean) => {
  // Canonicalised ONCE, at construction, so the containment comparison below
  // is against the same spelling `pathContains` will canonicalise a request
  // to — and so a per-request `realpath` of the root is not on the hot path.
  const root = input.root === null ? null : canonicalPath(input.root);

  return (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) return false;
    if (method !== 'GET' && method !== 'HEAD') return false;

    if (root === null) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(NOT_BUILT)),
      });
      res.end(NOT_BUILT);
      return true;
    }

    // Serving ONE file outside the bundle is serving the whole filesystem,
    // so containment goes through `pathContains` — the canonicalising helper
    // every other containment check in this repo uses. A raw
    // `startsWith(root + sep)` on a `normalize`d path is defeated by a
    // symlink inside the bundle pointing out of it, and this codebase has
    // already destroyed a user's file once behind exactly that mistake.
    // `decodeURIComponent` is what makes `%2e%2e` dangerous at all: the URL
    // parser collapses a literal `..` but leaves the encoded form intact.
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      // A malformed escape is not a path. Treated as "no such file", never
      // as a throw out of a request handler.
      decoded = '\0';
    }
    const requested = join(root, decoded);
    const isFile =
      // `existsSync` before `pathContains`: canonicalising a path that does
      // not exist falls back to a plain `resolve`, and the containment
      // answer only has to be trustworthy for something we would then read.
      existsSync(requested) && statSync(requested).isFile() && pathContains(root, requested);

    if (!isFile && extname(pathname) !== '') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return true;
    }

    const file = isFile ? requested : join(root, 'index.html');
    const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    // `index.html` must never be cached: it names the hashed asset bundle,
    // and a stale copy points a browser at chunks an upgrade deleted.
    const cache = file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
};
