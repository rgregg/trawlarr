import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './router.js';

/** The header a non-browser client sends its key in (spec 3.5). */
export const API_KEY_HEADER = 'x-api-key';

/**
 * ONE message for every way a request can fail to authenticate.
 *
 * A different message for "missing" versus "wrong" tells an attacker which
 * half of the problem they have already solved — that the endpoint exists,
 * that the header name was right, that the key was merely stale. There is
 * exactly one 401 body, and it says what a legitimate operator needs (which
 * header, and where the key lives) without confirming anything about the
 * attempt that was made.
 */
export const UNAUTHORIZED_MESSAGE =
  `This request was not authorised. Send the daemon's API key in the "X-Api-Key" header; it is ` +
  `stored as the "daemon.apiKey" setting and is generated on first start. Only ` +
  `GET /api/v1/system/health is reachable without it, so a container health check needs no ` +
  `secret.`;

export const unauthorized = (): ApiError => new ApiError(401, 'unauthorized', UNAUTHORIZED_MESSAGE);

/**
 * Constant-time key comparison.
 *
 * `timingSafeEqual` throws on unequal lengths, and a plain length check
 * before it would leak the key's length through timing — so a
 * wrong-length key is compared against the expected key itself (guaranteed
 * equal-length, guaranteed unequal in content) and the result is discarded.
 * The comparison always runs, and always over the same number of bytes.
 */
export const isAuthorised = (input: {
  provided: string | undefined;
  expected: string;
}): boolean => {
  const expected = Buffer.from(input.expected, 'utf8');
  const provided = Buffer.from(input.provided ?? '', 'utf8');

  if (provided.length !== expected.length) {
    // Same work, thrown away: the answer is already no.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(provided, expected);
};
