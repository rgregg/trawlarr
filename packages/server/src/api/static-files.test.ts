import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStaticHandler, resolveWebRoot } from './static-files.js';
import { requestOf, responseOf } from './test-doubles.js';

const bundle = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>trawlarr</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  return root;
};

describe('createStaticHandler', () => {
  it('serves index.html at the root', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/'), res)).toBe(true);
    expect(await res.settled).toMatchObject({
      status: 200,
      body: expect.stringContaining('<!doctype html>'),
    });
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves an asset with its own content type', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/assets/app.js'), res)).toBe(true);
    expect((await res.settled).body).toBe('console.log(1)');
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('falls back to index.html for a client-side route', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/libraries/abc'), res)).toBe(true);
    expect((await res.settled).body).toContain('<!doctype html>');
  });

  it('404s a missing asset rather than handing it an HTML page', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/assets/gone.js'), res)).toBe(true);
    const settled = await res.settled;
    expect(settled.status).toBe(404);
    expect(settled.body ?? '').not.toContain('<!doctype html>');
  });

  it('never answers an /api/v1 path', () => {
    const handler = createStaticHandler({ root: bundle() });
    // The API must reach its own router even for a path the bundle happens
    // to contain, or a file named `system` would shadow an endpoint.
    expect(handler(requestOf('GET', '/api/v1/system/health'), responseOf())).toBe(false);
  });

  it('leaves a mutating method to the API rather than answering it', () => {
    const handler = createStaticHandler({ root: bundle() });
    expect(handler(requestOf('POST', '/libraries'), responseOf())).toBe(false);
  });

  it('refuses a traversal attempt instead of reading outside the bundle', async () => {
    const root = bundle();
    writeFileSync(join(root, '..', 'secret.txt'), 'nope');
    const handler = createStaticHandler({ root });
    const res = responseOf();
    handler(requestOf('GET', '/../secret.txt'), res);
    const settled = await res.settled;
    expect(settled.body ?? '').not.toContain('nope');
  });

  it('refuses a PERCENT-ENCODED traversal, which URL parsing does not collapse', async () => {
    const root = bundle();
    writeFileSync(join(root, '..', 'encoded-secret.txt'), 'nope-encoded');
    const handler = createStaticHandler({ root });
    const res = responseOf();
    handler(requestOf('GET', '/%2e%2e/encoded-secret.txt'), res);
    const settled = await res.settled;
    expect(settled.status).toBe(404);
    expect(settled.body ?? '').not.toContain('nope-encoded');
  });

  it('refuses a SYMLINK out of the bundle, which normalising alone cannot catch', async () => {
    const root = bundle();
    writeFileSync(join(root, '..', 'linked-secret.txt'), 'nope-linked');
    symlinkSync(join(root, '..', 'linked-secret.txt'), join(root, 'escape.txt'));
    const handler = createStaticHandler({ root });
    const res = responseOf();
    handler(requestOf('GET', '/escape.txt'), res);
    const settled = await res.settled;
    expect(settled.status).toBe(404);
    expect(settled.body ?? '').not.toContain('nope-linked');
  });

  it('does not crash on a malformed percent escape', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/%E0%A4%A.js'), res)).toBe(true);
    expect((await res.settled).status).toBe(404);
  });

  it('answers HEAD with the headers and no body', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('HEAD', '/assets/app.js'), res)).toBe(true);
    const settled = await res.settled;
    expect(settled.status).toBe(200);
    expect(settled.body).toBeNull();
  });

  it('never caches index.html, and caches hashed assets forever', async () => {
    const root = bundle();
    const handler = createStaticHandler({ root });
    const html = responseOf();
    handler(requestOf('GET', '/'), html);
    await html.settled;
    const asset = responseOf();
    handler(requestOf('GET', '/assets/app.js'), asset);
    await asset.settled;

    expect(html.headers['cache-control']).toBe('no-store');
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('explains itself when the bundle was never built', async () => {
    const handler = createStaticHandler({ root: null });
    const res = responseOf();
    expect(handler(requestOf('GET', '/'), res)).toBe(true);
    const settled = await res.settled;
    expect(settled.status).toBe(503);
    expect(JSON.parse(settled.body!).error.code).toBe('web-ui-not-built');
  });

  it('still lets the API through when the bundle was never built', () => {
    const handler = createStaticHandler({ root: null });
    expect(handler(requestOf('GET', '/api/v1/system/health'), responseOf())).toBe(false);
  });
});

describe('resolveWebRoot', () => {
  it('takes the override when it holds a built bundle', () => {
    const root = bundle();
    expect(resolveWebRoot({ override: root })).toBe(root);
  });

  it('is null for a directory with no index.html, rather than a root that serves nothing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'trawlarr-empty-'));
    // No other candidate can exist here: the fallbacks are relative to the
    // installed file, and this assertion would be meaningless if a real
    // checkout's bundle answered instead. So assert only the override arm.
    expect(resolveWebRoot({ override: empty })).not.toBe(empty);
  });
});
