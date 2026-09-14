import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeRepo } from '../db/node-repo.js';
import type { BundleStore } from './bundles.js';

const API_PREFIX = '/api/v1';
const NODES_PREFIX = `${API_PREFIX}/nodes`;
const ENROLL_PATH = `${NODES_PREFIX}/enroll`;
const BUNDLES_PREFIX = `${NODES_PREFIX}/bundles/`;
const FILES_MARKER = '/files/';

/**
 * A node identifies itself, not an operator, so a token is a handful of
 * base64url bytes wrapped in `{"token": "..."}` — a hundred bytes at most.
 * 4 KiB is generous headroom over that, not an invitation: without a cap, a
 * single unauthenticated POST could buffer unbounded memory before this
 * handler ever gets to look at it.
 */
const MAX_ENROLL_BODY_BYTES = 4096;

/**
 * Handles a request that belongs to a remote node, before the ordinary
 * router and its operator auth ever see it. Resolves `true` once it has
 * written a full response; resolves `false` and writes NOTHING for every
 * other path, which is what lets `createApiHandler` fall through to the
 * normal router unharmed.
 *
 * The two failure modes this module exists to make impossible to get wrong
 * by accident — a client aborting an enroll body mid-write, and a bundle
 * file vanishing between the manifest walk and the read — are caught HERE
 * and turned into a response or a destroyed connection, never a rejected
 * promise. This does NOT extend to every failure this handler can hit: an
 * `argon2`/db error out of `NodeRepo.enroll`/`authenticate`, or a
 * `BundleWalkError`/`BundleLimitError` out of `BundleStore.manifestFor`, are
 * left to reject — `createApiHandler` (server.ts) awaits this call inside
 * its OWN try/catch (with a trailing `.catch` backstop beyond that), so an
 * escaping rejection still lands as a 500 rather than an unhandled
 * rejection. It is that outer wrapping, not a guarantee made in this file,
 * that keeps a node request from ever taking the daemon down with it.
 */
export type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
};

/**
 * ONE fixed message for every way a node's own request fails to
 * authenticate — unknown id, wrong secret, revoked node, missing headers —
 * for the same reason `api/auth.ts`'s `UNAUTHORIZED_MESSAGE` is singular: a
 * different message per reason would tell whoever is probing which half of
 * the credential they already have right.
 */
const NODE_UNAUTHORIZED_MESSAGE =
  `This request was not authorised as a node. Send "X-Trawlarr-Node: <nodeId>" and ` +
  `"Authorization: Bearer <secret>" — the secret returned by "POST ${ENROLL_PATH}".`;

const sendNodeUnauthorized = (res: ServerResponse): void => {
  sendJson(res, 401, { error: { code: 'unauthorized', message: NODE_UNAUTHORIZED_MESSAGE } });
};

/**
 * ONE fixed body for every way an enrollment token fails — unknown,
 * expired, already consumed, naming a node that has since been revoked, or
 * simply too large a body to ever have been a real token — so a caller
 * learns nothing about which of those it hit.
 */
const ENROLLMENT_REFUSED_MESSAGE =
  'This enrollment token is invalid, expired, already used, or its node has been revoked. ' +
  `Issue a new one from the operator UI or "POST ${NODES_PREFIX}/:id/enroll-token".`;

/**
 * `Connection: close` on this one response: an oversized/malformed body may
 * have left bytes on the wire this handler never fully read (see
 * `readCappedBody`'s early-reject-and-drain), and asking the client to open
 * a fresh connection for its next request is simpler and safer than
 * reasoning about where keep-alive framing landed after an abandoned read.
 */
const sendEnrollmentRefused = (res: ServerResponse): void => {
  sendJson(
    res,
    401,
    { error: 'enrollment_refused', message: ENROLLMENT_REFUSED_MESSAGE },
    { connection: 'close' },
  );
};

const BUNDLE_NOT_FOUND_MESSAGE = 'No such bundle, or no such file inside it.';

const sendBundleNotFound = (res: ServerResponse): void => {
  sendJson(res, 404, { error: { code: 'not-found', message: BUNDLE_NOT_FOUND_MESSAGE } });
};

/** The body was never going to be a real token; the caller stops reading and drains the rest. */
class BodyTooLargeError extends Error {}
/** The client went away mid-read. There is nobody left to answer. */
class ClientAbortedError extends Error {}

/**
 * Reads the body up to `maxBytes`, NEVER throwing a raw client-abort out to
 * the caller as an unhandled rejection: an abort resolves to
 * `ClientAbortedError` the same way an oversized body resolves to
 * `BodyTooLargeError` — both are just different reasons to stop reading and
 * answer (or, for an abort, not bother).
 *
 * An oversized body does NOT `req.destroy()` — it stops buffering
 * (`req.resume()` discards the remainder without holding it in memory) and
 * lets the caller send the fixed refusal on the still-open connection; only
 * a genuine client abort ends with nothing left to write to.
 */
const readCappedBody = async (req: IncomingMessage, maxBytes: number): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settle(() => reject(new BodyTooLargeError()));
        req.resume(); // drain the rest rather than buffer it; do not destroy the socket
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('aborted', () => settle(() => reject(new ClientAbortedError())));
    req.on('close', () => settle(() => reject(new ClientAbortedError())));
    req.on('error', () => settle(() => reject(new ClientAbortedError())));
  });

/** A malformed percent-escape is not a path segment; treated as itself, never thrown. */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * `X-Trawlarr-Node` + a bearer secret, checked with `NodeRepo.authenticate`
 * (which is itself the single source of truth for "unknown", "revoked" and
 * "wrong secret" all reading as `false`).
 */
const authenticateNode = async (req: IncomingMessage, nodes: NodeRepo): Promise<boolean> => {
  const nodeIdHeader = req.headers['x-trawlarr-node'];
  const nodeId = Array.isArray(nodeIdHeader) ? nodeIdHeader[0] : nodeIdHeader;
  const authHeader = req.headers.authorization;
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (nodeId === undefined || authValue === undefined || !authValue.startsWith('Bearer ')) {
    return false;
  }
  const secret = authValue.slice('Bearer '.length);
  return await nodes.authenticate({ nodeId, secret });
};

const handleEnroll = async (
  req: IncomingMessage,
  res: ServerResponse,
  input: { nodes: NodeRepo; nowMs: () => number },
): Promise<void> => {
  // Refused up front, before reading a byte, when the client announced a
  // body too large to ever hold a real token — the streaming cap below is
  // the backstop for a body that lied about (or omitted) its length.
  const declaredLength = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ENROLL_BODY_BYTES) {
    // Drain rather than ignore: the client is still writing up to
    // `declaredLength` bytes, and leaving them unread on the socket while
    // we write a response risks backpressure errors on some platforms.
    req.resume();
    sendEnrollmentRefused(res);
    return;
  }

  let raw: string;
  try {
    raw = await readCappedBody(req, MAX_ENROLL_BODY_BYTES);
  } catch (error) {
    if (error instanceof ClientAbortedError) return; // nobody left to answer
    if (!(error instanceof BodyTooLargeError)) throw error;
    sendEnrollmentRefused(res);
    return;
  }

  let token: unknown;
  try {
    token = raw === '' ? undefined : (JSON.parse(raw) as { token?: unknown }).token;
  } catch {
    sendEnrollmentRefused(res);
    return;
  }
  if (typeof token !== 'string' || token === '') {
    sendEnrollmentRefused(res);
    return;
  }

  const result = await input.nodes.enroll({ token, nowMs: input.nowMs() });
  if (result === null) {
    sendEnrollmentRefused(res);
    return;
  }
  sendJson(res, 200, { nodeId: result.nodeId, secret: result.secret });
};

/**
 * Streams `filePath` as `application/octet-stream`, and NEVER rejects: a
 * read error (the file vanished between the manifest walk and this read) or
 * the client hanging up mid-stream both end the promise via `resolve`, with
 * the response either completed, 404'd, or destroyed.
 *
 * Headers are written only once the file has actually `open`ed — not
 * eagerly before the read even starts — so the common race (the manifest
 * still lists a file that has since been deleted) 404s cleanly instead of
 * committing a 200 status the body can never back up. Once `open` HAS
 * fired, a later read error (truncated mid-stream, permissions yanked) has
 * no such option: the 200 is already on the wire, so the only honest move
 * left is to destroy the connection rather than let the client believe it
 * got a complete file.
 */
const streamBundleFile = async (res: ServerResponse, filePath: string): Promise<void> =>
  await new Promise<void>((resolve) => {
    let settled = false;
    let opened = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const stream = createReadStream(filePath);
    stream.on('open', () => {
      opened = true;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
    });
    stream.on('error', () => {
      stream.destroy();
      if (opened || res.headersSent) {
        res.destroy();
      } else {
        sendBundleNotFound(res);
      }
      finish();
    });
    res.on('error', () => {
      stream.destroy();
      finish();
    });
    // The client disconnecting mid-stream fires 'close' (usually alongside
    // 'finish' on a clean completion, never after it on an early hangup) —
    // either way the read stream must stop, and the promise must settle.
    res.on('close', () => {
      stream.destroy();
      finish();
    });
    res.on('finish', finish);

    stream.pipe(res);
  });

/**
 * Builds the node-facing HTTP surface: enrollment, and authenticated bundle
 * downloads. Mounted by `createApiHandler` (server.ts) ahead of the ordinary
 * router, because these endpoints authenticate with a node secret, not the
 * daemon's operator API key or session cookie the router enforces for
 * everything else.
 */
export const createNodeHttpHandler = (input: {
  nodes: NodeRepo;
  bundles: BundleStore;
  nowMs: () => number;
}): NodeHttpHandler => {
  return async (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (method === 'POST' && pathname === ENROLL_PATH) {
      await handleEnroll(req, res, input);
      return true;
    }

    if (method === 'GET' && pathname.startsWith(BUNDLES_PREFIX)) {
      if (!(await authenticateNode(req, input.nodes))) {
        sendNodeUnauthorized(res);
        return true;
      }

      const rest = pathname.slice(BUNDLES_PREFIX.length);
      const filesIndex = rest.indexOf(FILES_MARKER);

      if (filesIndex === -1) {
        // A manifest request: the whole remainder is the hash.
        const hash = decodeSegment(rest);
        const root = input.bundles.rootFor(hash);
        if (root === null) {
          sendBundleNotFound(res);
          return true;
        }
        const rewalked = await input.bundles.manifestFor(root);
        // The tree may have changed since `hash` was handed out. A rewalk
        // that lands on a DIFFERENT hash means the bundle `hash` named no
        // longer exists — `manifestFor` has already evicted its entries —
        // so answering with today's manifest under yesterday's hash would
        // tell a node it has the exact bytes that hash designates when it
        // does not.
        if (rewalked.hash !== hash) {
          sendBundleNotFound(res);
          return true;
        }
        sendJson(res, 200, rewalked.manifest);
        return true;
      }

      // The relPath may contain slashes ENCODED as `%2F` inside a single URL
      // segment; each raw (still-encoded) segment between literal `/`s is
      // decoded on its own and the decoded pieces are rejoined, so a decoded
      // `..` never gets treated as a real path separator. The joined string
      // is looked up in the bundle's manifest ONLY (`filePath` below) —
      // never joined onto a directory on disk — so a path that decodes to
      // `../../etc/passwd` simply isn't a manifest entry.
      const hash = decodeSegment(rest.slice(0, filesIndex));
      const rawRelPath = rest.slice(filesIndex + FILES_MARKER.length);
      const relPath = rawRelPath.split('/').map(decodeSegment).join('/');

      // Deliberately NOT a re-walk: `filePath` is an O(1) lookup against
      // whatever `manifestFor` last cached for this hash. A hash whose root
      // has since been re-walked to something else was already evicted from
      // these maps by `manifestFor` (see bundles.ts), so this still refuses
      // a stale hash — it just does not pay for a filesystem walk on every
      // single file a node pulls out of a bundle it already resolved.
      const filePath = input.bundles.filePath(hash, relPath);
      if (filePath === null) {
        sendBundleNotFound(res);
        return true;
      }

      await streamBundleFile(res, filePath);
      return true;
    }

    return false;
  };
};
