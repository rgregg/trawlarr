import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalPath, pathContains } from '../fs/path-contains.js';
import type { PluginSourceKind } from './plugin-repo.js';

export class PluginSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSourceError';
  }
}

export interface MaterialisedSource {
  dir: string;
  /** Removes anything this call created. A NO-OP for a local source. */
  cleanup: () => void;
}

/**
 * The bounds an untrusted archive is held to.
 *
 * These are parameters rather than constants because a limit that cannot be
 * lowered cannot be tested: proving the extracted-size bound with the
 * production value would mean building a multi-gigabyte fixture, and a test
 * that expensive is a test that gets deleted.
 */
export interface SourceLimits {
  /** Bytes of COMPRESSED archive accepted from the network. */
  maxDownloadBytes: number;
  /** Sum of the member sizes the archive declares, before extracting any. */
  maxExtractedBytes: number;
  maxMembers: number;
  /** Path components in a single member name. */
  maxPathDepth: number;
  maxRedirects: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  // Tdarr's plugin repository is a few megabytes; a plugin source two orders
  // of magnitude larger than that is not a plugin source.
  maxDownloadBytes: 256 * 1024 * 1024,
  maxExtractedBytes: 2 * 1024 * 1024 * 1024,
  maxMembers: 200_000,
  maxPathDepth: 64,
  maxRedirects: 5,
};

/**
 * How long `tar` gets to read an archive's index. A gzip bomb costs no disk
 * — `tar -t` writes nothing — but it does cost CPU, and the size bound below
 * cannot be applied until the index has been read. This bounds that window.
 */
const TAR_LIST_TIMEOUT_MS = 120_000;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * A GNU `tar -tv` line: type character, permission bits, owner, size, an ISO
 * timestamp, then the member name. Anything that does not match is refused
 * rather than skipped — a listing this code cannot read is a listing whose
 * member types and sizes it cannot check, and unchecked is the one thing an
 * archive from the internet may not be.
 */
const TAR_VERBOSE_LINE = /^([bcdhlps-])[rwxsStT-]{9}[.+@]?\s+\S+\s+(\d+)\s+\d{4,}-\d{2}-\d{2}\s/;

export interface ArchiveMember {
  /** The tar type character: `-` regular, `d` directory, `l` symlink, ... */
  type: string;
  sizeBytes: number;
  name: string;
}

const runTar = (tarball: string, args: string[]): string => {
  try {
    return execFileSync('tar', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: TAR_LIST_TIMEOUT_MS,
      // GNU tar prints ISO dates regardless of locale, but the diagnostics it
      // emits are translated; pinning the locale keeps both halves stable.
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch (cause) {
    throw new PluginSourceError(
      `Could not read plugin source archive "${tarball}" as a gzipped tar: ` +
        `${(cause as Error).message}`,
    );
  }
};

const lines = (output: string): string[] => output.split('\n').filter((line) => line.length > 0);

/**
 * Combine tar's two listings of the same archive into one index.
 *
 * Two listings, aligned by index, rather than one parsed listing: `-t` gives
 * the member name exactly as tar will use it (no ` -> target` suffix, leading
 * spaces intact), and `-tv` gives the type and the declared size. Parsing the
 * name back out of the verbose form is where an almost-right regex would
 * quietly check a DIFFERENT path from the one tar goes on to write.
 *
 * Both halves fail CLOSED. A listing that does not line up, or a verbose line
 * this does not recognise, is a listing whose member types and sizes cannot
 * be checked — and unchecked is the one thing an archive from the internet
 * may not be. Exported so both refusals can be exercised directly: GNU tar
 * escapes newlines in member names and always prints ISO dates, so no
 * archive built with it can be made to produce either shape.
 */
export const readArchiveIndex = (input: {
  names: string[];
  verbose: string[];
}): ArchiveMember[] => {
  if (input.names.length !== input.verbose.length) {
    throw new PluginSourceError(
      `Refusing this plugin source: its archive lists ${input.names.length} members by name but ` +
        `${input.verbose.length} in detail, so the names being checked are not the names that ` +
        `would be written.`,
    );
  }

  return input.names.map((name, index) => {
    const line = input.verbose[index]!;
    const match = TAR_VERBOSE_LINE.exec(line);
    if (match === null) {
      throw new PluginSourceError(
        `Refusing this plugin source: its archive contains a member this build of tar describes ` +
          `as "${line}", which trawlarr cannot check the type and size of.`,
      );
    }
    return { type: match[1]!, sizeBytes: Number(match[2]!), name };
  });
};

/** Read the archive's index WITHOUT extracting it. */
const listMembers = (tarball: string): ArchiveMember[] =>
  readArchiveIndex({
    names: lines(runTar(tarball, ['-tzf', tarball])),
    verbose: lines(runTar(tarball, ['-tvzf', tarball])),
  });

const TYPE_NAMES: Record<string, string> = {
  l: 'a symbolic link',
  h: 'a hard link',
  b: 'a block device',
  c: 'a character device',
  p: 'a FIFO',
  s: 'a socket',
};

/**
 * Refuse an archive that would write outside the directory we extract into,
 * or that would cost more to unpack than a plugin source can justify.
 *
 * A plugin source URL is something a user pasted, and it is fetched and
 * unpacked by the service user, which owns the whole data directory. GNU tar
 * does strip a leading slash and skip `..` members with a warning, but a
 * warning on stderr that nobody reads is not a control, and the behaviour is
 * not the same across tar implementations. Refusing outright, by name, is.
 *
 * Checked BEFORE extracting, because checking afterwards means the escape has
 * already happened — and for a symlink member in particular, "afterwards" is
 * too late by construction: the escape is a LATER member being written
 * through the link, during the same extraction.
 */
const assertSafeArchive = (input: {
  tarball: string;
  extractRoot: string;
  limits: SourceLimits;
}): void => {
  const members = listMembers(input.tarball);

  if (members.length > input.limits.maxMembers) {
    throw new PluginSourceError(
      `Refusing this plugin source: its archive holds ${members.length} members, more than the ` +
        `${input.limits.maxMembers} a plugin repository is allowed to unpack.`,
    );
  }

  // Canonicalised once, so the per-member comparison below is against a path
  // that has already had symlinks and `..` resolved out of it. The extraction
  // root exists by now precisely so this can follow links rather than guess.
  const root = canonicalPath(input.extractRoot);
  let totalBytes = 0;

  for (const member of members) {
    if (member.type !== '-' && member.type !== 'd') {
      throw new PluginSourceError(
        `Refusing this plugin source: its archive contains "${member.name}", which is ` +
          `${TYPE_NAMES[member.type] ?? `of type "${member.type}"`} rather than a file or a ` +
          `directory. A link inside an archive can point anywhere on this host, and a later ` +
          `member written through it lands outside the directory being unpacked.`,
      );
    }

    // Absolute names, `../` names and any spelling that normalises out of the
    // tree all fail this one check. Routed through the same containment
    // helper every other boundary in this codebase uses: a raw string
    // comparison here is the class of bug that once destroyed a user's file.
    if (!pathContains(root, resolve(root, member.name))) {
      throw new PluginSourceError(
        `Refusing this plugin source: its archive contains "${member.name}", which would be ` +
          `written outside the directory it is unpacked into. That is not a layout any plugin ` +
          `repository needs, so the archive is rejected rather than sanitised.`,
      );
    }

    const depth = member.name.split('/').filter((part) => part !== '' && part !== '.').length;
    if (depth > input.limits.maxPathDepth) {
      throw new PluginSourceError(
        `Refusing this plugin source: its archive contains a path ${depth} directories deep, ` +
          `past the limit of ${input.limits.maxPathDepth}. Nothing legitimate nests that far, ` +
          `and some filesystems and backup tools cannot then delete what was written.`,
      );
    }

    totalBytes += member.sizeBytes;
    if (totalBytes > input.limits.maxExtractedBytes) {
      throw new PluginSourceError(
        `Refusing this plugin source: its archive declares more than ` +
          `${input.limits.maxExtractedBytes} bytes of content, which a small download expanding ` +
          `to fill the disk looks exactly like.`,
      );
    }
  }
};

const assertHttpsUrl = (url: string, context: string): void => {
  if (!url.startsWith('https://')) {
    throw new PluginSourceError(
      `Plugin source url "${url}"${context} is not https. Plugin code is executed by trawlarr ` +
        `as the service user, so it is only ever fetched over a channel that authenticates the ` +
        `server it came from.`,
    );
  }
};

/**
 * A 200 carrying a login page or an error page is the ordinary failure of a
 * captive portal, a corporate proxy or a repository that has moved, and it
 * produces a far more confusing error from `tar` than from here.
 */
const assertArchiveContentType = (url: string, contentType: string | null): void => {
  if (contentType === null) return;
  const essence = contentType.split(';')[0]!.trim().toLowerCase();
  const isDocument =
    essence.startsWith('text/') || essence === 'application/json' || essence === 'application/xml';
  if (isDocument) {
    throw new PluginSourceError(
      `Plugin source "${url}" answered with content-type "${essence}", which is a document ` +
        `rather than an archive. A proxy, a captive portal or a moved repository serves a page ` +
        `with a 200 status, and unpacking that as a tarball is not something to attempt.`,
    );
  }
};

/**
 * Stream the body to disk, refusing past `maxBytes`.
 *
 * `response.arrayBuffer()` would buffer the whole reply in memory first,
 * which hands any server that answers a plugin-source request the ability to
 * decide how much memory this process uses.
 */
const streamToFile = async (input: {
  url: string;
  response: Response;
  dest: string;
  maxBytes: number;
}): Promise<void> => {
  const declared = Number(input.response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > input.maxBytes) {
    throw new PluginSourceError(
      `Refusing plugin source "${input.url}": it announces ${declared} bytes, past the ` +
        `${input.maxBytes}-byte limit for a plugin source archive.`,
    );
  }

  const fd = openSync(input.dest, 'w');
  try {
    const body = input.response.body;
    if (body === null) {
      throw new PluginSourceError(`Plugin source "${input.url}" returned an empty reply.`);
    }
    const reader = body.getReader();
    let received = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      received += chunk.value.byteLength;
      if (received > input.maxBytes) {
        // Cancelled rather than merely abandoned, so a server still sending
        // does not keep a socket and a pipe alive behind a rejected sync.
        await reader.cancel();
        throw new PluginSourceError(
          `Refusing plugin source "${input.url}": it sent more than ${input.maxBytes} bytes, ` +
            `which is past the limit for a plugin source archive.`,
        );
      }
      writeSync(fd, chunk.value);
    }
  } finally {
    closeSync(fd);
  }
};

/** The two bytes every gzip stream starts with. */
const assertGzip = (url: string, tarball: string): void => {
  const header = Buffer.alloc(2);
  const fd = openSync(tarball, 'r');
  let read = 0;
  try {
    read = readSync(fd, header, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 2 || header[0] !== 0x1f || header[1] !== 0x8b) {
    throw new PluginSourceError(
      `Plugin source "${url}" did not return a gzipped archive. Check the url — a tarball ` +
        `source wants a .tar.gz, such as a codeload.github.com tar.gz link.`,
    );
  }
};

/**
 * Follow redirects by hand rather than letting `fetch` do it, so every hop is
 * held to https. `fetch`'s own redirect handling will follow an https url to
 * an http one, and a source that starts secure and finishes in the clear is
 * exactly the case the https rule exists to stop.
 */
const fetchArchive = async (input: {
  url: string;
  fetchFn: typeof fetch;
  limits: SourceLimits;
}): Promise<Response> => {
  let current = input.url;
  for (let hop = 0; ; hop += 1) {
    assertHttpsUrl(current, hop === 0 ? '' : ` (redirected to from "${input.url}")`);
    const response = await input.fetchFn(current, { redirect: 'manual' });

    if (!REDIRECT_STATUS.has(response.status)) {
      if (!response.ok) {
        throw new PluginSourceError(
          `Could not fetch plugin source "${input.url}": HTTP ${response.status}.`,
        );
      }
      return response;
    }

    if (hop >= input.limits.maxRedirects) {
      throw new PluginSourceError(
        `Could not fetch plugin source "${input.url}": it redirects more than ` +
          `${input.limits.maxRedirects} times, which is a loop rather than a move.`,
      );
    }
    const location = response.headers.get('location');
    if (location === null) {
      throw new PluginSourceError(
        `Could not fetch plugin source "${input.url}": HTTP ${response.status} with no location ` +
          `to redirect to.`,
      );
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new PluginSourceError(
        `Could not fetch plugin source "${input.url}": it redirects to "${location}", which is ` +
          `not a url.`,
      );
    }
  }
};

export const materialiseSource = async (input: {
  kind: PluginSourceKind;
  url: string;
  cacheDir: string;
  /** Seam for tests; production uses the global fetch. */
  fetchFn?: typeof fetch;
  /** Overrides for individual bounds; anything omitted keeps its default. */
  limits?: Partial<SourceLimits>;
}): Promise<MaterialisedSource> => {
  if (input.kind === 'local') {
    // Rejected rather than resolved, for the same reason a relative
    // `stagingDir` is rejected at library creation: there is no defensible
    // base. The service's cwd is meaningless to the user, and `path.resolve`
    // is defined against it, so resolving early stores the wrong answer.
    if (!isAbsolute(input.url)) {
      throw new PluginSourceError(
        `Plugin source path "${input.url}" is relative. Give an absolute path — the service's ` +
          `working directory is not something you can predict, so a relative path would point ` +
          `somewhere different depending on how trawlarr was started.`,
      );
    }
    let stats;
    try {
      stats = statSync(input.url);
    } catch {
      throw new PluginSourceError(`Plugin source path "${input.url}" does not exist.`);
    }
    if (!stats.isDirectory()) {
      throw new PluginSourceError(
        `Plugin source path "${input.url}" is not a directory. A local source is the ROOT of a ` +
          `plugin tree, not a single plugin file.`,
      );
    }
    // No cleanup: this is the user's own directory, not something we made.
    return { dir: input.url, cleanup: () => {} };
  }

  assertHttpsUrl(input.url, '');
  const limits = { ...DEFAULT_SOURCE_LIMITS, ...input.limits };

  mkdirSync(input.cacheDir, { recursive: true });
  const workDir = mkdtempSync(join(input.cacheDir, 'source-'));
  const tarball = join(workDir, `${randomUUID()}.tar.gz`);
  const extractDir = join(workDir, 'tree');

  try {
    const response = await fetchArchive({
      url: input.url,
      fetchFn: input.fetchFn ?? fetch,
      limits,
    });
    assertArchiveContentType(input.url, response.headers.get('content-type'));
    await streamToFile({
      url: input.url,
      response,
      dest: tarball,
      maxBytes: limits.maxDownloadBytes,
    });
    assertGzip(input.url, tarball);

    mkdirSync(extractDir, { recursive: true });
    assertSafeArchive({ tarball, extractRoot: extractDir, limits });

    // `--strip-components=1` matches how every GitHub tarball is shaped: one
    // top-level `<repo>-<sha>` directory wrapping the tree. Stripping only
    // ever removes leading components, so a member already proven to stay
    // inside the root stays inside it after the strip too.
    execFileSync('tar', [
      '-xzf',
      tarball,
      '-C',
      extractDir,
      '--strip-components=1',
      // Nothing in a plugin source needs to own a file or carry setuid bits,
      // and neither survives a checkout anyway.
      '--no-same-owner',
      '--no-same-permissions',
    ]);
    rmSync(tarball, { force: true });
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }

  return { dir: extractDir, cleanup: () => rmSync(workDir, { recursive: true, force: true }) };
};
