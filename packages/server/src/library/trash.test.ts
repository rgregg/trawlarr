import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import type { LibraryRecord } from '../db/library-repo.js';
import { purgeTrash, trashRetentionDaysForFlow, DEFAULT_TRASH_RETENTION_DAYS } from './trash.js';
import { parsePluginId } from '../plugins/plugin-id.js';
import { resolveTrashDir } from './paths.js';

/**
 * The retention sweep. Every assertion is on files and bytes on disk; the
 * clock is a plain number, so nothing here sleeps or depends on timing.
 */

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const newRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-trash-'));
  dirs.push(root);
  return root;
};

const libraryFor = (root: string, over: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id: 'lib',
  name: 'Movies',
  roots: [root],
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
  ...over,
});

/** A file in the trash, named exactly the way `moveToTrash` names one. */
const trashEntry = (trashDir: string, stem: string, trashedAtMs: number, bytes: number): string => {
  mkdirSync(trashDir, { recursive: true });
  const path = join(trashDir, `${stem}.${trashedAtMs}.mkv`);
  writeFileSync(path, 'x'.repeat(bytes));
  return path;
};

describe('purgeTrash', () => {
  it('removes entries past the retention window and keeps the rest, reporting the bytes freed', async () => {
    const root = newRoot();
    const library = libraryFor(root);
    const trashDir = resolveTrashDir({ library, filePath: join(root, 'a.mkv') });

    const old = trashEntry(trashDir, 'old', NOW - 20 * DAY_MS, 100);
    const fresh = trashEntry(trashDir, 'fresh', NOW - 2 * DAY_MS, 50);
    // Exactly on the boundary: retention is a promise, so 14 days old with a
    // 14-day window is still inside it.
    const boundary = trashEntry(trashDir, 'boundary', NOW - 14 * DAY_MS, 10);

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(boundary)).toBe(true);
    expect(summary.removed).toBe(1);
    expect(summary.bytesFreed).toBe(100);
    expect(summary.retained).toBe(2);
  });

  it('ages an entry by when trawlarr trashed it, never by the file mtime it kept', async () => {
    const root = newRoot();
    const library = libraryFor(root);
    const trashDir = resolveTrashDir({ library, filePath: join(root, 'a.mkv') });

    // A move preserves mtime, so a 2009 film trashed a minute ago still has
    // a 2009 mtime. Ageing on mtime would delete the user's only copy of it
    // immediately — the entire safety net, gone on the first sweep.
    const justTrashed = trashEntry(trashDir, 'Ancient Film', NOW - 60_000, 10);
    const ancient = new Date(NOW - 5000 * DAY_MS);
    utimesSync(justTrashed, ancient, ancient);

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW });

    expect(existsSync(justTrashed)).toBe(true);
    expect(summary.removed).toBe(0);
  });

  it('never removes anything that resolves outside the trash directory', async () => {
    const root = newRoot();
    const library = libraryFor(root);
    const trashDir = resolveTrashDir({ library, filePath: join(root, 'a.mkv') });
    mkdirSync(trashDir, { recursive: true });

    const libraryFile = join(root, 'keep-me.mkv');
    writeFileSync(libraryFile, 'the user’s only copy');
    // A symlink inside trash, wearing a name old enough to purge, pointing
    // at a live library file. Containment is decided canonically, so this
    // entry resolves OUTSIDE the trash directory and is not ours to touch.
    const link = join(trashDir, `keep-me.${NOW - 90 * DAY_MS}.mkv`);
    symlinkSync(libraryFile, link);

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW });

    expect(existsSync(libraryFile)).toBe(true);
    expect(statSync(libraryFile).size).toBeGreaterThan(0);
    expect(summary.removed).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('leaves entries it did not name, including a live reservation, alone', async () => {
    const root = newRoot();
    const library = libraryFor(root);
    const trashDir = resolveTrashDir({ library, filePath: join(root, 'a.mkv') });
    mkdirSync(trashDir, { recursive: true });

    // Something a human put there.
    const handPlaced = join(trashDir, 'notes.txt');
    writeFileSync(handPlaced, 'mine');
    // A reservation another worker is holding RIGHT NOW: its name ends in a
    // trash-shaped timestamp, and deleting it would put two workers into the
    // one critical section that destroys files.
    const reservation = join(trashDir, `.trawlarr-reserve-old.${NOW - 90 * DAY_MS}.mkv`);
    writeFileSync(reservation, '');
    // A directory: trash entries are flat by construction, so anything else
    // is not ours and is never descended into.
    const stray = join(trashDir, 'a-directory');
    mkdirSync(stray);
    writeFileSync(join(stray, `inner.${NOW - 90 * DAY_MS}.mkv`), 'x');

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW });

    expect(existsSync(handPlaced)).toBe(true);
    expect(existsSync(reservation)).toBe(true);
    expect(existsSync(join(stray, `inner.${NOW - 90 * DAY_MS}.mkv`))).toBe(true);
    expect(summary.removed).toBe(0);
    expect(summary.skipped).toBe(3);
  });

  it('reports without removing anything under dryRun', async () => {
    const root = newRoot();
    const library = libraryFor(root);
    const trashDir = resolveTrashDir({ library, filePath: join(root, 'a.mkv') });
    const old = trashEntry(trashDir, 'old', NOW - 20 * DAY_MS, 100);

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW, dryRun: true });

    expect(existsSync(old)).toBe(true);
    expect(summary.removed).toBe(1);
    expect(summary.bytesFreed).toBe(100);
  });

  it('refuses to sweep a directory that contains a library root', async () => {
    const root = newRoot();
    const inner = join(root, 'library');
    mkdirSync(inner, { recursive: true });
    const library = libraryFor(inner, { trashDir: root });
    const bystander = join(root, `something.${NOW - 90 * DAY_MS}.mkv`);
    writeFileSync(bystander, 'not trash');

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW });

    expect(existsSync(bystander)).toBe(true);
    expect(summary.removed).toBe(0);
    expect(summary.dirsRefused).toBe(1);
  });

  it('sweeps every root of a multi-root library and tolerates one with no trash yet', async () => {
    const a = newRoot();
    const b = newRoot();
    const library = libraryFor(a, { roots: [a, b] });
    const trashA = resolveTrashDir({ library, filePath: join(a, 'x.mkv') });
    const old = trashEntry(trashA, 'old', NOW - 20 * DAY_MS, 7);

    const summary = await purgeTrash({ library, retentionDays: 14, nowMs: NOW });

    expect(existsSync(old)).toBe(false);
    expect(summary.dirsSwept).toBe(1);
    expect(summary.dirsMissing).toBe(1);
  });
});

describe('trashRetentionDaysForFlow', () => {
  const replaceNode = (id: string, days: string | undefined) => ({
    id,
    pluginId: 'trawlarr:replaceOriginal',
    pluginVersion: '1.0.0',
    inputs: days === undefined ? {} : { trashRetentionDays: days },
  });

  it('takes the value the flow declares', () => {
    const flow: FlowDefinition = { nodes: [replaceNode('r', '3')], edges: [] };
    expect(trashRetentionDaysForFlow(flow)).toBe(3);
  });

  it('takes the LONGEST retention any node declares, never the shortest', () => {
    const flow: FlowDefinition = {
      nodes: [replaceNode('a', '3'), replaceNode('b', '30')],
      edges: [],
    };
    expect(trashRetentionDaysForFlow(flow)).toBe(30);
  });

  it('falls back to the value the node itself declares as its default', () => {
    const flow: FlowDefinition = { nodes: [replaceNode('r', undefined)], edges: [] };
    expect(trashRetentionDaysForFlow(flow)).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    expect(trashRetentionDaysForFlow({ nodes: [], edges: [] })).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    // Rubbish is not zero: a typo must never mean "purge everything now".
    expect(trashRetentionDaysForFlow({ nodes: [replaceNode('r', 'soon')], edges: [] })).toBe(
      DEFAULT_TRASH_RETENTION_DAYS,
    );
  });

  it('is unmoved by an INSTALLED plugin, which can never be the Replace node', () => {
    // The reserved namespace, load-bearing here: a source may not be called
    // `trawlarr`, so the closest an installed plugin can come to the Replace
    // node's id is `<some source>:replaceOriginal`. Its retention input must
    // not be read as this flow's promise about how long an original is kept —
    // it is a different plugin that writes no trash at all.
    expect(parsePluginId('trawlarr:replaceOriginal')).toBeNull();
    const flow: FlowDefinition = {
      nodes: [
        {
          id: 'installed',
          pluginId: 'tdarr:replaceOriginal',
          pluginVersion: '1.0.0',
          inputs: { trashRetentionDays: '0' },
        },
      ],
      edges: [],
    };
    expect(trashRetentionDaysForFlow(flow)).toBe(DEFAULT_TRASH_RETENTION_DAYS);
  });

  it('reads the default from the node definition rather than a second copy of it', () => {
    // The plugin's declared defaultValue is the single source of truth: if
    // someone changes the node's tooltip default, this constant follows.
    expect(DEFAULT_TRASH_RETENTION_DAYS).toBe(14);
  });
});
