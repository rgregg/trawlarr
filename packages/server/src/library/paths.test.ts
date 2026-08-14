import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LibraryRecord } from '../db/library-repo.js';
import { ensureDir, isSameFilesystem, resolveStagingDir, resolveTrashDir } from './paths.js';

const NOW = 1_700_000_000_000;

const makeLibrary = (overrides: Partial<LibraryRecord> & { roots: string[] }): LibraryRecord => ({
  id: 'lib-1',
  name: 'Movies',
  extensions: ['mkv'],
  companionExtensions: ['srt'],
  stagingDir: null,
  trashDir: null,
  flowId: null,
  allowHardlinked: false,
  enabled: true,
  pausedReason: null,
  userVariables: {},
  createdAt: NOW,
  ...overrides,
});

describe('resolveStagingDir', () => {
  it('uses the configured stagingDir when set', () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const library = makeLibrary({ roots: [root], stagingDir: '/config/staging' });
    expect(resolveStagingDir({ library, filePath: join(root, 'movie.mkv') })).toBe(
      '/config/staging',
    );
  });

  it('defaults to a hidden directory under the root that contains the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const library = makeLibrary({ roots: [root] });
    const result = resolveStagingDir({ library, filePath: join(root, 'nested', 'movie.mkv') });
    expect(result).toBe(join(root, '.trawlarr', 'staging'));
  });

  it('picks the root that actually contains the file, not one whose name is merely a string prefix', () => {
    // Regression for the incident where a raw string-prefix comparison let
    // `/library-old` be treated as inside `/library`. `library-old` sorts
    // after `library` as a plain string too, so a naive `startsWith` check
    // without a separator boundary would wrongly match the wrong root.
    const base = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const libraryDir = join(base, 'library');
    const libraryOldDir = join(base, 'library-old');
    mkdirSync(libraryDir, { recursive: true });
    mkdirSync(libraryOldDir, { recursive: true });

    const library = makeLibrary({ roots: [libraryDir, libraryOldDir] });
    const filePath = join(libraryOldDir, 'movie.mkv');

    const result = resolveStagingDir({ library, filePath });
    expect(result).toBe(join(libraryOldDir, '.trawlarr', 'staging'));
  });
});

describe('resolveTrashDir', () => {
  it('uses the configured trashDir when set', () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const library = makeLibrary({ roots: [root], trashDir: '/config/trash' });
    expect(resolveTrashDir({ library, filePath: join(root, 'movie.mkv') })).toBe('/config/trash');
  });

  it('defaults to a hidden directory under the root that contains the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const library = makeLibrary({ roots: [root] });
    const result = resolveTrashDir({ library, filePath: join(root, 'movie.mkv') });
    expect(result).toBe(join(root, '.trawlarr', 'trash'));
  });
});

describe('ensureDir', () => {
  it('creates nested directories and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const target = join(root, 'a', 'b', 'c');

    await ensureDir(target);
    await ensureDir(target); // must not throw the second time

    const stats = await stat(target);
    expect(stats.isDirectory()).toBe(true);
  });
});

describe('isSameFilesystem', () => {
  it('returns true for two paths within one temp directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const a = join(root, 'a');
    const b = join(root, 'b', 'c');
    mkdirSync(a);
    mkdirSync(join(root, 'b'));

    expect(await isSameFilesystem(a, b)).toBe(true);
  });

  it('walks up to the nearest existing ancestor for a path that does not exist yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-paths-'));
    const notYetCreated = join(root, 'does', 'not', 'exist', 'yet');

    expect(await isSameFilesystem(root, notYetCreated)).toBe(true);
  });

  it('returns false for two paths that are genuinely on different devices', async () => {
    // Guarded rather than asserted unconditionally: /dev/shm is a Linux-only
    // tmpfs mount, and even where it exists it isn't guaranteed to sit on a
    // different device than the OS temp dir. Skip instead of failing on a
    // platform/config where the premise doesn't hold — but where it does
    // (this machine: /tmp is dev 2050, /dev/shm is dev 26), this is the one
    // test in the file that would catch `isSameFilesystem` degrading into
    // `async () => true`.
    if (!existsSync('/dev/shm')) return;
    const [tmpDev, shmDev] = await Promise.all([
      stat(tmpdir()).then((s) => s.dev),
      stat('/dev/shm').then((s) => s.dev),
    ]);
    if (tmpDev === shmDev) return;

    expect(await isSameFilesystem(tmpdir(), '/dev/shm')).toBe(false);
  });
});
