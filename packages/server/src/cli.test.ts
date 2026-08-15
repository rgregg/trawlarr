import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLibraryRepo } from './db/library-repo.js';
import { createFlowRepo } from './db/flow-repo.js';
import { main } from './cli.js';

/**
 * Unit-level coverage for every error path, exit code, and validation rule
 * `cli.ts` owns — the surface the end-to-end suite only exercises where its
 * one happy path happens to pass through. `main` is called in-process
 * (never as a subprocess), so these run fast and need no built `dist/`.
 */

const hasFfmpegSync = (): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const ffmpegAvailable = hasFfmpegSync();

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

const stdout = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const stderr = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

const newDataDir = (): string => join(mkdtempSync(join(tmpdir(), 'trawlarr-cli-unit-')), 'data');

const MINIMAL_FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

describe('cli: dispatch', () => {
  it('reports "no command given" and non-zero exit when invoked bare', async () => {
    expect(await main([])).not.toBe(0);
    expect(stderr()).toContain('No command given.');
  });

  it('names the unknown command rather than printing bare usage', async () => {
    expect(await main(['nonsense'])).not.toBe(0);
    expect(stderr()).toContain('Unknown command: "nonsense".');
  });

  it('names the unknown subcommand for a known top-level word', async () => {
    expect(await main(['library', 'frobnicate'])).not.toBe(0);
    expect(stderr()).toContain('Unknown command: "library frobnicate".');
  });

  it('explains that options must follow the command, not precede it', async () => {
    const dataDir = newDataDir();
    expect(await main(['--data-dir', dataDir, 'library', 'add'])).not.toBe(0);
    expect(stderr()).toContain('Unrecognized option "--data-dir"');
    expect(stderr()).toContain('must come AFTER the command');
  });

  it('never prints a raw stack trace for a thrown error', async () => {
    await main(['scan', '--library', 'nope', '--data-dir', newDataDir()]);
    expect(stderr()).not.toContain('    at '); // the shape of a V8 stack frame
    expect(stderr()).toContain('Error:');
  });
});

describe('cli: library add', () => {
  it('requires --name', async () => {
    expect(await main(['library', 'add', '--root', '/tmp', '--data-dir', newDataDir()])).not.toBe(
      0,
    );
    expect(stderr()).toContain('--name is required');
  });

  it('requires at least one --root', async () => {
    expect(await main(['library', 'add', '--name', 'X', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('--root is required');
  });

  it('rejects a duplicate name with its own message, not a raw sqlite error', async () => {
    const dataDir = newDataDir();
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    expect(
      await main(['library', 'add', '--name', 'Movies', '--root', root, '--data-dir', dataDir]),
    ).toBe(0);

    const otherRoot = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    expect(
      await main([
        'library',
        'add',
        '--name',
        'Movies',
        '--root',
        otherRoot,
        '--data-dir',
        dataDir,
      ]),
    ).not.toBe(0);
    expect(stderr()).toContain('a library named "Movies" already exists');
    expect(stderr()).not.toContain('UNIQUE constraint failed');
  });

  it('rejects --extensions that reduce to nothing usable', async () => {
    expect(
      await main([
        'library',
        'add',
        '--name',
        'X',
        '--root',
        mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-')),
        '--extensions',
        '',
        '--data-dir',
        newDataDir(),
      ]),
    ).not.toBe(0);
    expect(stderr()).toContain('no usable extension');
  });

  it('normalises a leading dot instead of creating a library that can never match a file', async () => {
    const dataDir = newDataDir();
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    expect(
      await main([
        'library',
        'add',
        '--name',
        'X',
        '--root',
        root,
        '--extensions',
        '.mkv,.MP4',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);

    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).getByName('X');
    expect(library?.extensions).toEqual(['mkv', 'mp4']);
    db.close();
  });
});

describe('cli: flow add', () => {
  it('requires --name and --file', async () => {
    expect(await main(['flow', 'add', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('--name is required');
  });

  it('reports an unparsable flow file cleanly', async () => {
    const dataDir = newDataDir();
    const badFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-cli-flow-')), 'bad.json');
    // Deliberately not writing anything valid to badFile: readFile on a
    // non-existent path is the common case (a mistyped --file).
    expect(
      await main(['flow', 'add', '--name', 'F', '--file', badFile, '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('could not read/parse');
  });

  it('rejects a duplicate flow name with its own message', async () => {
    const dataDir = newDataDir();
    const flowFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-cli-flow-')), 'flow.json');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(flowFile, JSON.stringify(MINIMAL_FLOW), 'utf8'),
    );
    expect(
      await main(['flow', 'add', '--name', 'F', '--file', flowFile, '--data-dir', dataDir]),
    ).toBe(0);
    expect(
      await main(['flow', 'add', '--name', 'F', '--file', flowFile, '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('a flow named "F" already exists');
    expect(stderr()).not.toContain('UNIQUE constraint failed');
  });
});

describe('cli: library set-flow', () => {
  it('rejects an unknown library', async () => {
    expect(
      await main([
        'library',
        'set-flow',
        '--library',
        'nope',
        '--flow',
        'nope',
        '--data-dir',
        newDataDir(),
      ]),
    ).not.toBe(0);
    expect(stderr()).toContain('Unknown library');
  });
});

describe('cli: scan', () => {
  it('rejects an unknown library', async () => {
    expect(await main(['scan', '--library', 'nope', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('Unknown library');
  });

  it('refuses to scan a library with no flow attached, naming the fix', async () => {
    const dataDir = newDataDir();
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    await main(['library', 'add', '--name', 'NoFlow', '--root', root, '--data-dir', dataDir]);
    expect(await main(['scan', '--library', 'NoFlow', '--data-dir', dataDir])).not.toBe(0);
    expect(stderr()).toContain('has no flow attached');
    expect(stderr()).toContain('library set-flow');
  });
});

describe('cli: run', () => {
  it('rejects a non-numeric --max instead of silently truncating it', async () => {
    expect(await main(['run', '--max', '3abc', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('--max must be a non-negative integer');
  });

  it('rejects a negative --max', async () => {
    // `--max -1` is ambiguous to `parseArgs` itself (looks like a short
    // option) and rejected before this validation ever runs — `--max=-1`
    // is the unambiguous way to pass a negative value through, and is what
    // actually reaches `parseNonNegativeInt`.
    expect(await main(['run', '--max=-1', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('--max must be a non-negative integer');
  });

  it('rejects an unknown --library', async () => {
    expect(await main(['run', '--library', 'nope', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('Unknown library');
  });

  it('claims nothing against an empty database and still exits 0', async () => {
    expect(await main(['run', '--data-dir', newDataDir()])).toBe(0);
    expect(stdout()).toContain('Claimed 0 file(s)');
  });
});

describe('cli: status', () => {
  it('reports no libraries on a fresh database', async () => {
    expect(await main(['status', '--data-dir', newDataDir()])).toBe(0);
    expect(stdout()).toContain('No libraries configured.');
  });

  it('rejects an unknown --library', async () => {
    expect(await main(['status', '--library', 'nope', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('Unknown library');
  });

  it('floors the percentage instead of rounding up: 995/1000 good reads 99%, not 100%', async () => {
    const dataDir = newDataDir();
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    await main(['library', 'add', '--name', 'Big', '--root', root, '--data-dir', dataDir]);

    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).getByName('Big')!;
    const insert = db.prepare(
      `INSERT INTO media_file (
         id, library_id, content_key, path, size_bytes, mtime_ms, ctime_ms,
         container, state, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 'mkv', ?, 0, 0)`,
    );
    for (let i = 0; i < 1000; i += 1) {
      insert.run(
        `file-${i}`,
        library.id,
        `content-${i}`,
        `/x/${i}.mkv`,
        i < 995 ? 'good' : 'queued',
      );
    }
    db.close();

    expect(await main(['status', '--data-dir', dataDir])).toBe(0);
    const match = /\((\d+)% converged\)/.exec(stdout());
    expect(match?.[1]).toBe('99');
  });
});

describe.runIf(ffmpegAvailable)('cli: run --library restricts the drain', () => {
  const makeSample = async (path: string): Promise<void> => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=64x48:rate=5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      path,
    ]);
  };

  /** Matches real h264 samples with no encode step, so this stays fast. */
  const NO_OP_FLOW: FlowDefinition = {
    nodes: [
      { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      {
        id: 'check',
        pluginId: 'trawlarr:checkVideoCodec',
        pluginVersion: '1.0.0',
        inputs: { codec: 'h264' },
      },
    ],
    edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
  };

  it('only claims files from the named library, leaving the other library queued', async () => {
    const dataDir = newDataDir();
    const rootA = mkdtempSync(join(tmpdir(), 'trawlarr-cli-libA-'));
    const rootB = mkdtempSync(join(tmpdir(), 'trawlarr-cli-libB-'));
    await makeSample(join(rootA, 'a.mkv'));
    await makeSample(join(rootB, 'b.mkv'));

    const flowFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-cli-flow-')), 'flow.json');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(flowFile, JSON.stringify(NO_OP_FLOW), 'utf8'),
    );

    await main(['library', 'add', '--name', 'A', '--root', rootA, '--data-dir', dataDir]);
    await main(['library', 'add', '--name', 'B', '--root', rootB, '--data-dir', dataDir]);
    await main(['flow', 'add', '--name', 'NoOp', '--file', flowFile, '--data-dir', dataDir]);
    await main(['library', 'set-flow', '--library', 'A', '--flow', 'NoOp', '--data-dir', dataDir]);
    await main(['library', 'set-flow', '--library', 'B', '--flow', 'NoOp', '--data-dir', dataDir]);
    await main(['scan', '--library', 'A', '--data-dir', dataDir]);
    await main(['scan', '--library', 'B', '--data-dir', dataDir]);

    expect(await main(['run', '--library', 'A', '--data-dir', dataDir])).toBe(0);

    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const libraryRepo = createLibraryRepo(db);
    const flowRepo = createFlowRepo(db);
    expect(flowRepo.getByName('NoOp')).not.toBeNull();
    const a = libraryRepo.getByName('A')!;
    const b = libraryRepo.getByName('B')!;
    const stateOf = (libraryId: string) =>
      (
        db.prepare('SELECT state FROM media_file WHERE library_id = ?').get(libraryId) as {
          state: string;
        }
      ).state;
    expect(stateOf(a.id)).toBe('good');
    expect(stateOf(b.id)).toBe('queued'); // untouched: run was restricted to A
    db.close();
  }, 60_000);
});
