import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

/**
 * Minimal `IncomingMessage`/`ServerResponse` doubles for handlers that are
 * pure functions of a request.
 *
 * These exist for UNIT-level assertions only. Anything that has to prove the
 * daemon as a whole behaves — routing precedence, auth, status codes on the
 * wire — is tested against a real `http.Server` over a real socket in
 * `api.test.ts`, because a handler called directly can pass while the path
 * the daemon actually takes never runs it.
 */
export type ResponseDouble = ServerResponse & {
  /** Header names, lower-cased, as `writeHead` received them. */
  headers: Record<string, string>;
  /** Resolves once `end()` has been called, with what was written. */
  settled: Promise<{ status: number; body: string | null }>;
};

export const requestOf = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage => ({ method, url, headers }) as unknown as IncomingMessage;

/**
 * A response that records instead of writing.
 *
 * It is a real `Writable`, not a bag of spies, so `createReadStream(f).pipe(res)`
 * works against it exactly as it does against a socket — a double that only
 * had `end()` would silently record nothing for the streaming path, which is
 * the path that serves every asset.
 */
export const responseOf = (): ResponseDouble => {
  const chunks: Buffer[] = [];
  let status = 0;
  let settle: (value: { status: number; body: string | null }) => void = () => {};
  const settled = new Promise<{ status: number; body: string | null }>((resolve) => {
    settle = resolve;
  });

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Buffer));
      callback();
    },
  });

  // Assembled as a loose record and cast ONCE. Assigning to the members of
  // an already-cast `ServerResponse` fights the overloads on `writeHead`
  // for no benefit: nothing here is a real `ServerResponse`, and pretending
  // otherwise member-by-member only moves the cast.
  const bag = stream as unknown as Record<string, unknown>;
  bag.headers = {};
  bag.settled = settled;
  const record = (name: string, value: unknown): void => {
    (bag.headers as Record<string, string>)[name.toLowerCase()] = String(value);
  };
  bag.writeHead = (code: number, headers?: Record<string, string | number>): unknown => {
    status = code;
    for (const [name, value] of Object.entries(headers ?? {})) record(name, value);
    return bag;
  };
  bag.setHeader = (name: string, value: string | number): unknown => {
    record(name, value);
    return bag;
  };

  stream.on('finish', () => {
    settle({ status, body: chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8') });
  });

  return bag as unknown as ResponseDouble;
};
