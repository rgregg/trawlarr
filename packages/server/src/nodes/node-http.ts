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
 */
export type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
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
 * expired, already consumed, or naming a node that has since been revoked —
 * so a caller learns nothing about which of those it hit.
 */
const ENROLLMENT_REFUSED_MESSAGE =
  'This enrollment token is invalid, expired, already used, or its node has been revoked. ' +
  `Issue a new one from the operator UI or "POST ${NODES_PREFIX}/:id/enroll-token".`;

const sendEnrollmentRefused = (res: ServerResponse): void => {
  sendJson(res, 401, { error: 'enrollment_refused', message: ENROLLMENT_REFUSED_MESSAGE });
};

const BUNDLE_NOT_FOUND_MESSAGE = 'No such bundle, or no such file inside it.';

const sendBundleNotFound = (res: ServerResponse): void => {
  sendJson(res, 404, { error: { code: 'not-found', message: BUNDLE_NOT_FOUND_MESSAGE } });
};

class BodyTooLargeError extends Error {}

const readCappedBody = async (req: IncomingMessage, maxBytes: number): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
      let raw: string;
      try {
        raw = await readCappedBody(req, MAX_ENROLL_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error;
        // A body this large cannot be a real token either way — refused
        // with the same single message as any other bad token, so an
        // oversized body tells a prober nothing it did not already know.
        sendEnrollmentRefused(res);
        return true;
      }

      let token: unknown;
      try {
        token = raw === '' ? undefined : (JSON.parse(raw) as { token?: unknown }).token;
      } catch {
        sendEnrollmentRefused(res);
        return true;
      }
      if (typeof token !== 'string' || token === '') {
        sendEnrollmentRefused(res);
        return true;
      }

      const result = await input.nodes.enroll({ token, nowMs: input.nowMs() });
      if (result === null) {
        sendEnrollmentRefused(res);
        return true;
      }
      sendJson(res, 200, { nodeId: result.nodeId, secret: result.secret });
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
        const { manifest } = await input.bundles.manifestFor(root);
        sendJson(res, 200, manifest);
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

      const filePath = input.bundles.filePath(hash, relPath);
      if (filePath === null) {
        sendBundleNotFound(res);
        return true;
      }

      await new Promise<void>((resolve, reject) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        res.on('close', resolve);
        res.on('finish', resolve);
        stream.pipe(res);
      });
      return true;
    }

    return false;
  };
};
