import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materialiseSource, PluginSourceError, readArchiveIndex } from './fetch-source.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'trawlarr-src-'));

/** Build a real .tar.gz containing the given relative paths. */
const makeTarball = (entries: Record<string, string>, opts?: { evil?: boolean }): string => {
  const dir = scratch();
  const payload = join(dir, 'payload');
  mkdirSync(payload, { recursive: true });
  for (const [rel, body] of Object.entries(entries)) {
    const abs = join(payload, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  const out = join(dir, 'src.tar.gz');
  if (opts?.evil === true) {
    // A member whose name escapes the extraction root. Built with an explicit
    // transform so the archive really contains "../escaped.js" as a member
    // name, which is the thing under test.
    execFileSync('tar', [
      '-czf',
      out,
      '-C',
      payload,
      '--transform',
      's|^|../|',
      ...Object.keys(entries),
    ]);
  } else {
    execFileSync('tar', ['-czf', out, '-C', payload, '.']);
  }
  return out;
};

/** The member names the archive really carries, as tar itself reports them. */
const memberNames = (tarball: string): string[] =>
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);

describe('local sources', () => {
  it('uses the directory as-is', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'marker.txt'), 'hello', 'utf8');
    const source = await materialiseSource({ kind: 'local', url: dir, cacheDir: scratch() });
    expect(readFileSync(join(source.dir, 'marker.txt'), 'utf8')).toBe('hello');
  });

  it('never deletes the user-s own directory on cleanup', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'marker.txt'), 'hello', 'utf8');
    const source = await materialiseSource({ kind: 'local', url: dir, cacheDir: scratch() });
    source.cleanup();
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
  });

  it('refuses a path that is not a directory, by name', async () => {
    const dir = scratch();
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x', 'utf8');
    await expect(
      materialiseSource({ kind: 'local', url: file, cacheDir: scratch() }),
    ).rejects.toThrow(PluginSourceError);
  });

  it('refuses a relative path, because there is no defensible base to resolve it against', async () => {
    await expect(
      materialiseSource({ kind: 'local', url: 'plugins', cacheDir: scratch() }),
    ).rejects.toThrow(PluginSourceError);
  });
});

describe('tarball sources', () => {
  const serve = (path: string): typeof fetch =>
    (async () => new Response(readFileSync(path), { status: 200 })) as unknown as typeof fetch;

  it('extracts the archive into the cache directory', async () => {
    const tarball = makeTarball({ 'a/b/index.js': 'module.exports = {};' });
    const source = await materialiseSource({
      kind: 'tarball',
      url: 'https://example.test/x.tar.gz',
      cacheDir: scratch(),
      fetchFn: serve(tarball),
    });
    expect(existsSync(join(source.dir, 'a', 'b', 'index.js'))).toBe(true);
  });

  it('cleans up what it extracted', async () => {
    const tarball = makeTarball({ 'a/index.js': 'x' });
    const source = await materialiseSource({
      kind: 'tarball',
      url: 'https://example.test/x.tar.gz',
      cacheDir: scratch(),
      fetchFn: serve(tarball),
    });
    source.cleanup();
    expect(existsSync(source.dir)).toBe(false);
  });

  it('refuses an archive containing a member that escapes the extraction root', async () => {
    // The whole point: a plugin source is a URL a user pasted, and a tarball
    // member named "../../etc/cron.d/x" would otherwise be written outside the
    // cache directory as the service user.
    const tarball = makeTarball({ 'escaped.js': 'pwned' }, { evil: true });
    // Guards the guard: if tar had refused to BUILD the evil archive, the
    // rejection below would pass for the wrong reason and prove nothing.
    expect(memberNames(tarball)).toContain('../escaped.js');
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'https://example.test/evil.tar.gz',
        cacheDir: scratch(),
        fetchFn: serve(tarball),
      }),
    ).rejects.toThrow(/outside/i);
  });

  it('refuses a non-https url, so a source cannot be fetched in the clear', async () => {
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'http://example.test/x.tar.gz',
        cacheDir: scratch(),
      }),
    ).rejects.toThrow(PluginSourceError);
  });

  it('reports a failed fetch with the status, not an anonymous throw', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'https://example.test/missing.tar.gz',
        cacheDir: scratch(),
        fetchFn: failing,
      }),
    ).rejects.toThrow(/404/);
  });
});

/**
 * Hostile archives, each built for real rather than described. Every case
 * asserts what ended up on disk as well as what was thrown, because "it
 * threw" and "it threw before writing anything" are different guarantees and
 * only the second one is worth having.
 */
describe('tarball sources: hostile archives', () => {
  const serve = (path: string): typeof fetch =>
    (async () => new Response(readFileSync(path), { status: 200 })) as unknown as typeof fetch;

  /** Refuse, and leave the cache directory as empty as it was found. */
  const expectRefusal = async (
    tarball: string,
    pattern: RegExp,
    limits?: Parameters<typeof materialiseSource>[0]['limits'],
  ): Promise<void> => {
    const cacheDir = scratch();
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'https://example.test/evil.tar.gz',
        cacheDir,
        fetchFn: serve(tarball),
        limits,
      }),
    ).rejects.toThrow(pattern);
    expect(readdirSync(cacheDir)).toEqual([]);
  };

  it('refuses an archive carrying an absolute member name', async () => {
    const dir = scratch();
    const victim = join(dir, 'absolute-escape.js');
    writeFileSync(victim, 'pwned', 'utf8');
    const out = join(scratch(), 'abs.tar.gz');
    // -P keeps the leading slash, so the member name really is absolute.
    execFileSync('tar', ['-czPf', out, victim]);
    expect(memberNames(out)).toContain(victim);

    await expectRefusal(out, /outside/i);
    expect(readFileSync(victim, 'utf8')).toBe('pwned');
  });

  it('refuses an archive containing a symlink, which a later member writes through', async () => {
    const payload = join(scratch(), 'payload');
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, 'harmless.js'), 'ok', 'utf8');
    symlinkSync('/etc', join(payload, 'escape'));
    const out = join(scratch(), 'link.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', payload, '.']);

    await expectRefusal(out, /symbolic link/i);
  });

  it('refuses an archive containing a hard link', async () => {
    const payload = join(scratch(), 'payload');
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, 'first.js'), 'shared', 'utf8');
    linkSync(join(payload, 'first.js'), join(payload, 'second.js'));
    const out = join(scratch(), 'hard.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', payload, '.']);

    await expectRefusal(out, /hard link/i);
  });

  it('refuses a small archive that declares a huge expansion, before unpacking any of it', async () => {
    const payload = join(scratch(), 'payload');
    mkdirSync(payload, { recursive: true });
    // One mebibyte of zeros: about a kibibyte on the wire, a mebibyte on disk.
    writeFileSync(join(payload, 'bomb.bin'), Buffer.alloc(1024 * 1024), null);
    const out = join(scratch(), 'bomb.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', payload, '.']);
    expect(readFileSync(out).byteLength).toBeLessThan(64 * 1024);

    await expectRefusal(out, /declares more than/i, { maxExtractedBytes: 4096 });
  });

  it('refuses an archive with more members than a plugin repository may unpack', async () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) entries[`f${index}.js`] = 'x';
    await expectRefusal(makeTarball(entries), /members, more than/i, { maxMembers: 10 });
  });

  it('refuses a path nested past the depth limit', async () => {
    const deep = new Array(12).fill('nested').join('/');
    await expectRefusal(makeTarball({ [`${deep}/index.js`]: 'x' }), /directories deep/i, {
      maxPathDepth: 6,
    });
  });

  it('refuses a reply that is not gzip at all', async () => {
    const notAnArchive = join(scratch(), 'page.html');
    writeFileSync(notAnArchive, '<html><body>sign in</body></html>', 'utf8');
    await expectRefusal(notAnArchive, /gzipped archive/i);
  });

  it('accepts a cache directory reached through a symlink, rather than mistaking it for an escape', async () => {
    // The containment check canonicalises, so a data directory that is a bind
    // mount or a symlink — the shape of most containerised setups — must not
    // read as every member escaping.
    const real = scratch();
    const link = join(scratch(), 'cache-link');
    symlinkSync(real, link);
    const source = await materialiseSource({
      kind: 'tarball',
      url: 'https://example.test/x.tar.gz',
      cacheDir: link,
      fetchFn: serve(makeTarball({ 'a/index.js': 'module.exports = {};' })),
    });
    expect(existsSync(join(source.dir, 'a', 'index.js'))).toBe(true);
  });
});

/**
 * The two listings tar is asked for have to agree before anything is checked
 * against them. GNU tar cannot be made to produce either shape below — it
 * escapes newlines in member names and always prints an ISO date — so these
 * drive the reader directly rather than through an archive.
 */
describe('reading a tar index', () => {
  it('reads type, size and name from listings that line up', () => {
    expect(
      readArchiveIndex({
        names: ['./', './a/plugin.js'],
        verbose: [
          'drwxr-xr-x root/root         0 2024-03-01 09:15 ./',
          '-rw-r--r-- root/root      4096 2024-03-01 09:15 ./a/plugin.js',
        ],
      }),
    ).toEqual([
      { type: 'd', sizeBytes: 0, name: './' },
      { type: '-', sizeBytes: 4096, name: './a/plugin.js' },
    ]);
  });

  it('refuses listings of different lengths, rather than checking misaligned names', () => {
    expect(() =>
      readArchiveIndex({
        names: ['./harmless.js'],
        verbose: [
          '-rw-r--r-- root/root         3 2024-03-01 09:15 ./harmless.js',
          '-rw-r--r-- root/root         3 2024-03-01 09:15 ../escaped.js',
        ],
      }),
    ).toThrow(/lists 1 members by name but 2 in detail/);
  });

  it('refuses a verbose line it cannot read the type and size out of', () => {
    expect(() =>
      readArchiveIndex({
        names: ['./a.js'],
        verbose: ['a listing shape from some other tar'],
      }),
    ).toThrow(/cannot check the type and size of/);
  });
});

/**
 * Fetch behaviour against a REAL http server: real status lines, real
 * headers, real redirects, real chunked bodies. The https rule is enforced on
 * the url trawlarr is given, so the seam rewrites that url onto the loopback
 * server rather than standing in for `fetch` itself — the response objects
 * under test are the ones undici built.
 */
describe('tarball sources: a real server', () => {
  const withServer = async (
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    run: (fetchFn: typeof fetch) => Promise<void>,
  ): Promise<void> => {
    const server: Server = createServer((request, response) => {
      response.on('error', () => {});
      handler(request, response);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const fetchFn: typeof fetch = (input, init) =>
      fetch(String(input).replace('https://plugins.test', base), init);
    try {
      await run(fetchFn);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  };

  it('downloads and extracts an archive served over the wire', async () => {
    const tarball = readFileSync(makeTarball({ 'a/index.js': 'module.exports = {};' }));
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-gzip' });
        response.end(tarball);
      },
      async (fetchFn) => {
        const source = await materialiseSource({
          kind: 'tarball',
          url: 'https://plugins.test/x.tar.gz',
          cacheDir: scratch(),
          fetchFn,
        });
        expect(existsSync(join(source.dir, 'a', 'index.js'))).toBe(true);
      },
    );
  });

  it('follows a redirect that stays on https', async () => {
    const tarball = readFileSync(makeTarball({ 'moved/index.js': 'module.exports = {};' }));
    await withServer(
      (request, response) => {
        if (request.url === '/start.tar.gz') {
          response.writeHead(302, { location: 'https://plugins.test/real.tar.gz' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(tarball);
      },
      async (fetchFn) => {
        const source = await materialiseSource({
          kind: 'tarball',
          url: 'https://plugins.test/start.tar.gz',
          cacheDir: scratch(),
          fetchFn,
        });
        expect(existsSync(join(source.dir, 'moved', 'index.js'))).toBe(true);
      },
    );
  });

  it('refuses a redirect that drops to http, which fetch would otherwise follow', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(301, { location: 'http://plugins.test/x.tar.gz' });
        response.end();
      },
      async (fetchFn) => {
        const cacheDir = scratch();
        await expect(
          materialiseSource({
            kind: 'tarball',
            url: 'https://plugins.test/start.tar.gz',
            cacheDir,
            fetchFn,
          }),
        ).rejects.toThrow(/is not https/i);
        expect(readdirSync(cacheDir)).toEqual([]);
      },
    );
  });

  it('refuses a redirect loop rather than following it forever', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(302, { location: 'https://plugins.test/round.tar.gz' });
        response.end();
      },
      async (fetchFn) => {
        await expect(
          materialiseSource({
            kind: 'tarball',
            url: 'https://plugins.test/round.tar.gz',
            cacheDir: scratch(),
            fetchFn,
            limits: { maxRedirects: 3 },
          }),
        ).rejects.toThrow(/redirects more than 3 times/i);
      },
    );
  });

  it('refuses a page served with a 200, rather than handing it to tar', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><body>Sign in to continue</body></html>');
      },
      async (fetchFn) => {
        await expect(
          materialiseSource({
            kind: 'tarball',
            url: 'https://plugins.test/x.tar.gz',
            cacheDir: scratch(),
            fetchFn,
          }),
        ).rejects.toThrow(/content-type "text\/html"/i);
      },
    );
  });

  it('refuses an announced length past the limit without downloading the body', async () => {
    let bytesSent = 0;
    await withServer(
      (_request, response) => {
        const body = Buffer.alloc(64 * 1024, 0x41);
        response.writeHead(200, { 'content-length': String(body.byteLength) });
        bytesSent += body.byteLength;
        response.end(body);
      },
      async (fetchFn) => {
        await expect(
          materialiseSource({
            kind: 'tarball',
            url: 'https://plugins.test/huge.tar.gz',
            cacheDir: scratch(),
            fetchFn,
            limits: { maxDownloadBytes: 1024 },
          }),
        ).rejects.toThrow(/announces 65536 bytes/i);
      },
    );
    expect(bytesSent).toBe(65536);
  });

  it('stops a body that keeps coming past the limit, instead of buffering all of it', async () => {
    await withServer(
      (_request, response) => {
        // No content-length: the size is only discoverable while reading, so
        // the running total is the only thing that can stop this.
        response.writeHead(200);
        for (let chunk = 0; chunk < 16; chunk += 1) response.write(Buffer.alloc(8192, 0x42));
        response.end();
      },
      async (fetchFn) => {
        const cacheDir = scratch();
        await expect(
          materialiseSource({
            kind: 'tarball',
            url: 'https://plugins.test/endless.tar.gz',
            cacheDir,
            fetchFn,
            limits: { maxDownloadBytes: 4096 },
          }),
        ).rejects.toThrow(/sent more than 4096 bytes/i);
        expect(readdirSync(cacheDir)).toEqual([]);
      },
    );
  });
});
