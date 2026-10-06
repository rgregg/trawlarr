import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverInterruptedSwap, type SwapJournal } from './swap-journal.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A library in which a worker died with the original in trash and its path empty. */
const stranded = (): {
  root: string;
  outside: string;
  dir: string;
  original: string;
  trashed: string;
  journal: SwapJournal;
  notePath: string;
} => {
  const base = mkdtempSync(join(tmpdir(), 'trawlarr-journal-'));
  dirs.push(base);
  const root = join(base, 'library');
  const outside = join(base, 'elsewhere');
  const dir = join(root, 'Film');
  const trashDir = join(dir, '.trawlarr', 'trash');
  mkdirSync(trashDir, { recursive: true });
  mkdirSync(outside);
  const original = join(dir, 'Film.mkv');
  writeFileSync(original, 'the original');
  const { dev, ino } = statSync(original);
  const trashed = join(trashDir, 'Film.1700000000000.mkv');
  linkSync(original, trashed);
  rmSync(original);
  const journal: SwapJournal = {
    version: 1,
    originalPath: original,
    finalPath: original,
    stagedPath: join(dir, '.trawlarr-replace-x.mkv'),
    trashDir,
    trashNowMs: 1_700_000_000_000,
    originalDev: dev,
    originalIno: ino,
  };
  const notePath = join(dir, '.trawlarr-swap-1.json');
  writeFileSync(notePath, JSON.stringify(journal));
  return { root, outside, dir, original, trashed, journal, notePath };
};

const withNote = (s: ReturnType<typeof stranded>, changes: Partial<SwapJournal>): void => {
  writeFileSync(s.notePath, JSON.stringify({ ...s.journal, ...changes }));
};

describe('recoverInterruptedSwap trusts nothing it reads back', () => {
  it('restores from a well-formed note', async () => {
    const s = stranded();

    const result = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });

    expect(result.outcome).toBe('restored');
    expect(readFileSync(s.original, 'utf8')).toBe('the original');
  });

  it('refuses a note whose original path is outside the roots, touching nothing', async () => {
    const s = stranded();
    const victim = join(s.outside, 'victim.mkv');
    withNote(s, {
      originalPath: victim,
      finalPath: victim,
      stagedPath: join(s.outside, '.trawlarr-replace-x.mkv'),
    });

    const result = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });

    expect(result.outcome).toBe('refused');
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(s.trashed)).toBe(true);
    expect(existsSync(s.notePath)).toBe(true);
  });

  it('refuses a trash directory outside the roots', async () => {
    const s = stranded();
    withNote(s, { trashDir: s.outside });

    const result = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });

    expect(result.outcome).toBe('refused');
    expect(existsSync(s.original)).toBe(false);
  });

  it('accepts a trash directory outside the roots only when it is the configured one', async () => {
    const s = stranded();
    const trashDir = join(s.outside, 'trash');
    mkdirSync(trashDir);
    const moved = join(trashDir, 'Film.1700000000000.mkv');
    linkSync(s.trashed, moved);
    rmSync(s.trashed);
    withNote(s, { trashDir });

    expect((await recoverInterruptedSwap(s.notePath, { roots: [s.root] })).outcome).toBe('refused');
    const allowed = await recoverInterruptedSwap(s.notePath, {
      roots: [s.root],
      trashDirs: [s.outside],
    });
    expect(allowed.outcome).toBe('restored');
    expect(readFileSync(s.original, 'utf8')).toBe('the original');
  });

  it('refuses `..` segments and relative paths', async () => {
    const s = stranded();
    withNote(s, { originalPath: join(s.dir, '..', '..', 'elsewhere', 'victim.mkv') });
    expect((await recoverInterruptedSwap(s.notePath, { roots: [s.root] })).outcome).toBe('refused');

    withNote(s, { originalPath: 'Film.mkv', finalPath: 'Film.mkv' });
    expect((await recoverInterruptedSwap(s.notePath, { roots: [s.root] })).outcome).toBe('refused');
    expect(existsSync(join(s.outside, 'victim.mkv'))).toBe(false);
  });

  it('refuses a path that reaches outside the root through a symlinked directory', async () => {
    const s = stranded();
    const escape = join(s.root, 'escape');
    symlinkSync(s.outside, escape);
    const victim = join(escape, 'victim.mkv');
    withNote(s, {
      originalPath: victim,
      finalPath: victim,
      stagedPath: join(escape, '.trawlarr-replace-x.mkv'),
    });

    const result = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });

    expect(result.outcome).toBe('refused');
    expect(existsSync(join(s.outside, 'victim.mkv'))).toBe(false);
  });

  it('refuses a note that is not in the directory it describes', async () => {
    const s = stranded();
    const other = join(s.root, 'Other');
    mkdirSync(other);
    const moved = join(other, '.trawlarr-swap-1.json');
    writeFileSync(moved, readFileSync(s.notePath));

    const result = await recoverInterruptedSwap(moved, { roots: [s.root] });

    expect(result.outcome).toBe('refused');
    expect(existsSync(s.original)).toBe(false);
  });

  it('refuses a staged name that is not the replace step own', async () => {
    const s = stranded();
    withNote(s, { stagedPath: join(s.dir, 'Film.mkv.bak') });

    expect((await recoverInterruptedSwap(s.notePath, { roots: [s.root] })).outcome).toBe('refused');
  });

  it('reports malformed notes as invalid rather than as nothing to recover', async () => {
    const s = stranded();
    writeFileSync(s.notePath, '{not json');
    const broken = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });
    expect(broken.outcome).toBe('invalid');

    writeFileSync(s.notePath, JSON.stringify({ ...s.journal, trashNowMs: 'soon' }));
    const mistyped = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });
    expect(mistyped.outcome).toBe('invalid');

    writeFileSync(s.notePath, JSON.stringify([1, 2]));
    expect((await recoverInterruptedSwap(s.notePath, { roots: [s.root] })).outcome).toBe('invalid');
    // Left in place for a human, and nothing was moved.
    expect(existsSync(s.notePath)).toBe(true);
    expect(existsSync(s.trashed)).toBe(true);
  });

  it('will not restore from a symlink in trash', async () => {
    const s = stranded();
    rmSync(s.trashed);
    const target = join(s.outside, 'secret.mkv');
    writeFileSync(target, 'not yours');
    symlinkSync(target, s.trashed);

    const result = await recoverInterruptedSwap(s.notePath, { roots: [s.root] });

    expect(result.outcome).toBe('unrecoverable');
    expect(existsSync(s.original)).toBe(false);
  });

  it('refuses a file that is not named like a swap note', async () => {
    const s = stranded();
    const odd = join(s.dir, 'notes.json');
    writeFileSync(odd, readFileSync(s.notePath));

    expect((await recoverInterruptedSwap(odd, { roots: [s.root] })).outcome).toBe('invalid');
  });
});
