import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLibraryRepo } from './db/library-repo.js';
import { createFlowRepo } from './db/flow-repo.js';
import { createPluginRepo } from './plugins/plugin-repo.js';
import { main } from './cli.js';
import { toolAvailableSync } from '../../../test-support/tool-availability.js';

/**
 * Unit-level coverage for every error path, exit code, and validation rule
 * `cli.ts` owns — the surface the end-to-end suite only exercises where its
 * one happy path happens to pass through. `main` is called in-process
 * (never as a subprocess), so these run fast and need no built `dist/`.
 */

// See `toolAvailableSync`: only ENOENT means "not installed" and skips;
// a check that could not be trusted throws instead of skipping silently.
const ffmpegAvailable = toolAvailableSync('ffmpeg');

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

  it('treats --help/-h/help as a request, not a mistake', async () => {
    for (const argv of [['--help'], ['-h'], ['help']]) {
      logSpy.mockClear();
      errorSpy.mockClear();
      // The most common first command anyone types must not answer with an
      // error line and a non-zero exit.
      expect(await main(argv)).toBe(0);
      expect(stdout()).toContain('Usage:');
      expect(stdout()).toContain('trawlarr scan --library');
      expect(stderr()).toBe('');
    }
  });

  it('still explains a genuinely misplaced option', async () => {
    const dataDir = newDataDir();
    expect(await main(['--data-dir', dataDir, 'scan'])).not.toBe(0);
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

  /**
   * `flow add` is where a user meets flow validation, so the message has to
   * name the offending node, say what to fix, and say what running the flow
   * unvalidated would have cost — and nothing may be stored.
   */
  it('refuses a flow with a duplicate node id, naming the node and the consequence', async () => {
    const dataDir = newDataDir();
    const flowFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-cli-flow-')), 'dup.json');
    writeFileSync(
      flowFile,
      JSON.stringify({
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          { id: 'enc', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
          { id: 'enc', pluginId: 'trawlarr:verifyOutput', pluginVersion: '1.0.0', inputs: {} },
        ],
        edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'enc' }],
      }),
      'utf8',
    );

    expect(
      await main(['flow', 'add', '--name', 'Dup', '--file', flowFile, '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('"enc"');
    expect(stderr()).toContain('flow add');

    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    expect(createFlowRepo(db).list()).toHaveLength(0);
    db.close();
  });

  it('refuses a flow with a dangling edge and one with no start node', async () => {
    const dataDir = newDataDir();
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-cli-flow-'));

    const danglingFile = join(dir, 'dangling.json');
    writeFileSync(
      danglingFile,
      JSON.stringify({
        nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
        edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'encode' }],
      }),
      'utf8',
    );
    expect(
      await main(['flow', 'add', '--name', 'D', '--file', danglingFile, '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('"encode"');

    const noStartFile = join(dir, 'no-start.json');
    writeFileSync(
      noStartFile,
      JSON.stringify({
        nodes: [
          {
            id: 'check',
            pluginId: 'trawlarr:checkVideoCodec',
            pluginVersion: '1.0.0',
            inputs: { codec: 'h264' },
          },
        ],
        edges: [],
      }),
      'utf8',
    );
    expect(
      await main(['flow', 'add', '--name', 'N', '--file', noStartFile, '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('start');

    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    expect(createFlowRepo(db).list()).toHaveLength(0);
    db.close();
  });

  it('builds a flow from a template, with --set values in the stored definition', async () => {
    const dataDir = newDataDir();

    expect(
      await main([
        'flow',
        'add',
        '--name',
        'Movies HEVC',
        '--template',
        'transcode-hevc',
        '--set',
        'encoder=hevc_nvenc',
        '--set',
        'quality=22',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);

    // The STORED definition, not the printed line: a template that rendered
    // correctly and stored something else would look identical on stdout.
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const stored = createFlowRepo(db).getByName('Movies HEVC')!;
    expect(stored.definition.nodes.find((node) => node.id === 'encoder')!.inputs).toEqual({
      encoder: 'hevc_nvenc',
      quality: '22',
      hardwareDecoding: 'false',
    });
    // Output 1 of the codec check is "already hevc" and must stay a dead end.
    expect(stored.definition.edges.filter((edge) => edge.fromNodeId === 'check')).toEqual([
      { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
    ]);
    db.close();
  });

  it('refuses a template whose community plugins are not installed, naming them', async () => {
    const dataDir = newDataDir();

    expect(
      await main([
        'flow',
        'add',
        '--name',
        'Conform',
        '--template',
        'conform-library',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(1);

    // The missing plugin ids, source-prefixed, and the two commands that fix
    // it. A flow naming an unresolvable plugin VALIDATES (unknown is treated
    // as neutral), so without this it would have stored and then failed on
    // every file with an error naming the file instead.
    expect(stderr()).toContain('"tdarr:ffmpegCommandSetContainer"');
    expect(stderr()).toContain('"tdarr:ffmpegCommandCustomArguments"');
    expect(stderr()).toContain('"tdarr:ffmpegCommandEnsureAudioStream"');
    expect(stderr()).toContain('"tdarr:ffmpegCommandRemoveStreamByProperty"');
    expect(stderr()).toContain('trawlarr plugin source add --name tdarr');
    expect(stderr()).toContain('trawlarr plugin source sync --name tdarr');

    // Nothing stored: the observable half of "refused".
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    expect(createFlowRepo(db).list()).toHaveLength(0);
    db.close();
  });

  it('names the source the user chose when refusing, not the default one', async () => {
    const dataDir = newDataDir();
    expect(
      await main([
        'flow',
        'add',
        '--name',
        'Conform',
        '--template',
        'conform-library',
        '--set',
        'pluginSource=mine',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(1);
    expect(stderr()).toContain('"mine:ffmpegCommandSetContainer"');
    expect(stderr()).toContain('trawlarr plugin source sync --name mine');
  });

  it('stores the conform template once its community plugins are installed', async () => {
    const dataDir = newDataDir();
    mkdirSync(dataDir, { recursive: true });
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const plugins = createPluginRepo(db);
    plugins.addSource({ id: 'tdarr', url: '/nowhere', kind: 'local' });
    plugins.replaceSourcePlugins(
      'tdarr',
      [
        'ffmpegCommandSetContainer',
        'ffmpegCommandCustomArguments',
        'ffmpegCommandEnsureAudioStream',
        'ffmpegCommandRemoveStreamByProperty',
      ].map((pluginName) => ({
        pluginName,
        relPath: `${pluginName}/1.0.0/index.js`,
        absPath: `/nowhere/${pluginName}/1.0.0/index.js`,
        version: '1.0.0',
        details: {
          name: pluginName,
          description: '',
          style: { borderColor: 'blue' },
          tags: '',
          isStartPlugin: false,
          pType: '',
          sidebarPosition: -1,
          icon: '',
          inputs: [],
          outputs: [{ number: 1, tooltip: 'Continue to next plugin' }],
          requiresVersion: '2.11.01',
        },
      })),
    );
    db.close();

    expect(
      await main([
        'flow',
        'add',
        '--name',
        'Conform',
        '--template',
        'conform-library',
        '--set',
        'encoder=libx265',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);

    const after = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    const stored = createFlowRepo(after).getByName('Conform')!;
    expect(stored.definition.nodes.find((node) => node.id === 'encoder')!.inputs).toEqual({
      encoder: 'libx265',
      quality: '23',
      hardwareDecoding: 'false',
    });
    expect(stored.definition.nodes.find((node) => node.id === 'muxqueue')!.inputs).toEqual({
      inputArguments: '',
      outputArguments: '-max_muxing_queue_size 2048',
    });
    after.close();
  });

  it('refuses an unknown template, and a --set naming a parameter it does not have', async () => {
    const dataDir = newDataDir();

    expect(
      await main(['flow', 'add', '--name', 'A', '--template', 'nope', '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('transcode-hevc');

    expect(
      await main([
        'flow',
        'add',
        '--name',
        'B',
        '--template',
        'transcode-hevc',
        '--set',
        'encodr=hevc_nvenc',
        '--data-dir',
        dataDir,
      ]),
    ).not.toBe(0);
    expect(stderr()).toContain('"encodr"');

    // Neither attempt got as far as opening a database, which is the strongest
    // form of "nothing was stored" available here.
    expect(existsSync(join(dataDir, 'trawlarr.db'))).toBe(false);
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

  it('sweeps expired trash at the end of a drain, using the retention the flow declares', async () => {
    const dataDir = newDataDir();
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    await main(['library', 'add', '--name', 'Movies', '--root', root, '--data-dir', dataDir]);

    // A flow that declares a 3-day retention on its Replace node.
    const flowFile = join(mkdtempSync(join(tmpdir(), 'trawlarr-cli-flow-')), 'flow.json');
    writeFileSync(
      flowFile,
      JSON.stringify({
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'replace',
            pluginId: 'trawlarr:replaceOriginal',
            pluginVersion: '1.0.0',
            inputs: { trashRetentionDays: '3' },
          },
        ],
        edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'replace' }],
      }),
      'utf8',
    );
    await main(['flow', 'add', '--name', 'F', '--file', flowFile, '--data-dir', dataDir]);
    await main([
      'library',
      'set-flow',
      '--library',
      'Movies',
      '--flow',
      'F',
      '--data-dir',
      dataDir,
    ]);

    const trashDir = join(root, '.trawlarr', 'trash');
    mkdirSync(trashDir, { recursive: true });
    const expired = join(trashDir, `old.${Date.now() - 10 * 24 * 60 * 60 * 1000}.mkv`);
    const keep = join(trashDir, `new.${Date.now() - 24 * 60 * 60 * 1000}.mkv`);
    writeFileSync(expired, 'x'.repeat(2048));
    writeFileSync(keep, 'y');

    expect(await main(['run', '--library', 'Movies', '--data-dir', dataDir])).toBe(0);

    // Files on disk, not log text: the 3-day retention the flow declared is
    // the one that was applied.
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });
});

describe('cli: trash purge', () => {
  it('names the unknown subcommand', async () => {
    expect(await main(['trash', 'empty', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('Unknown command: "trash empty"');
  });

  it('removes nothing under --dry-run, and removes it for real without', async () => {
    const dataDir = newDataDir();
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
    await main(['library', 'add', '--name', 'Movies', '--root', root, '--data-dir', dataDir]);

    const trashDir = join(root, '.trawlarr', 'trash');
    mkdirSync(trashDir, { recursive: true });
    const expired = join(trashDir, `old.${Date.now() - 40 * 24 * 60 * 60 * 1000}.mkv`);
    writeFileSync(expired, 'x'.repeat(4096));

    expect(
      await main(['trash', 'purge', '--library', 'Movies', '--dry-run', '--data-dir', dataDir]),
    ).toBe(0);
    expect(existsSync(expired)).toBe(true);

    expect(await main(['trash', 'purge', '--library', 'Movies', '--data-dir', dataDir])).toBe(0);
    expect(existsSync(expired)).toBe(false);
  });

  it('rejects a non-numeric --days rather than sweeping on a NaN window', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    expect(
      await main([
        'trash',
        'purge',
        '--library',
        'Movies',
        '--days',
        'soon',
        '--data-dir',
        dataDir,
      ]),
    ).not.toBe(0);
    expect(stderr()).toContain('--days must be a non-negative integer');
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

/**
 * Seeds a library with rows in given states, returning their ids in order.
 * Written directly rather than through a scan so a state like
 * `not_converging` (which only a real run can produce) can be set up
 * cheaply, and so these tests need no ffmpeg.
 */
const seedFiles = (dataDir: string, libraryName: string, states: string[]): string[] => {
  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);
  const library = createLibraryRepo(db).getByName(libraryName)!;
  const insert = db.prepare(
    `INSERT INTO media_file (
       id, library_id, content_key, path, size_bytes, mtime_ms, ctime_ms,
       container, state, attempt_count, hold_until_ms, discovered_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 0, 0, 'mkv', ?, 3, 999, 0, 0)`,
  );
  const ids = states.map((state, i) => {
    const id = `seeded-${String(i)}`;
    insert.run(id, library.id, `content-${String(i)}`, `/movies/${String(i)}.mkv`, state);
    return id;
  });
  db.close();
  return ids;
};

const stateOfFile = (dataDir: string, fileId: string) => {
  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);
  const row = db
    .prepare('SELECT state, attempt_count, hold_until_ms FROM media_file WHERE id = ?')
    .get(fileId) as
    { state: string; attempt_count: number; hold_until_ms: number | null } | undefined;
  db.close();
  return row;
};

const addLibrary = async (dataDir: string, name: string): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-root-'));
  await main(['library', 'add', '--name', name, '--root', root, '--data-dir', dataDir]);
};

describe('cli: status --files', () => {
  it('says what an empty library means instead of reporting it as 0% converged', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Empty');

    expect(await main(['status', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('no files tracked yet');
    expect(stdout()).toContain('trawlarr scan --library Empty');
    // The number a new user reads as failure on their very first command.
    expect(stdout()).not.toContain('(0% converged)');
  });

  it('prints the file ids requeue takes, filtered by state', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const ids = seedFiles(dataDir, 'Movies', ['good', 'failed', 'not_converging']);

    expect(
      await main([
        'status',
        '--library',
        'Movies',
        '--files',
        '--state',
        'failed',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);
    expect(stdout()).toContain(ids[1]!);
    expect(stdout()).not.toContain(ids[0]!);
    expect(stdout()).not.toContain(ids[2]!);
  });

  it('rejects a mistyped --state rather than silently listing nothing', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    expect(await main(['status', '--state', 'faild', '--data-dir', dataDir])).not.toBe(0);
    expect(stderr()).toContain('is not a file state');
  });

  it('leaves a missing file out of the convergence percentage and lists it under --missing', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const ids = seedFiles(dataDir, 'Movies', ['good', 'queued']);
    // The second file was deleted from disk while still queued — the shape
    // that used to cap this library below 100% for ever.
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    db.prepare('UPDATE media_file SET missing_since_ms = ? WHERE id = ?').run(
      1_700_000_000_000,
      ids[1]!,
    );
    db.close();

    expect(await main(['status', '--library', 'Movies', '--data-dir', dataDir])).toBe(0);
    // Parsed, not substring-matched: '100% converged'.includes('0% converged').
    expect(/\((\d+)% converged\)/.exec(stdout())?.[1]).toBe('100');
    expect(stdout()).toContain('1 file(s) are gone from disk');

    logSpy.mockClear();
    expect(await main(['status', '--library', 'Movies', '--missing', '--data-dir', dataDir])).toBe(
      0,
    );
    expect(stdout()).toContain(ids[1]!);
    expect(stdout()).not.toContain(ids[0]!);
    expect(stdout()).toContain('MISSING since');
  });

  it('rejects --missing together with --state rather than silently ignoring one', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    expect(
      await main(['status', '--missing', '--state', 'queued', '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('use either --missing or --state');
  });

  it('points at requeue when a library holds terminal files', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    seedFiles(dataDir, 'Movies', ['failed', 'not_converging']);
    expect(await main(['status', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('trawlarr requeue --file <id>');
  });
});

describe('cli: reap', () => {
  /** A row left `running`, claimed `agoMs` ago, with no job row at all. */
  const seedRunning = (dataDir: string, libraryName: string, agoMs: number): string => {
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).getByName(libraryName)!;
    const id = `stranded-${String(agoMs)}`;
    db.prepare(
      `INSERT INTO media_file (
         id, library_id, content_key, path, size_bytes, mtime_ms, ctime_ms,
         container, state, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 'mkv', 'running', 0, ?)`,
    ).run(
      id,
      library.id,
      `content-${String(agoMs)}`,
      `/movies/${String(agoMs)}.mkv`,
      Date.now() - agoMs,
    );
    db.close();
    return id;
  };

  const stateOf = (dataDir: string, fileId: string): string => {
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    const row = db.prepare('SELECT state FROM media_file WHERE id = ?').get(fileId) as {
      state: string;
    };
    db.close();
    return row.state;
  };

  it('says so plainly when nothing is running', async () => {
    expect(await main(['reap', '--data-dir', newDataDir()])).toBe(0);
    expect(stdout()).toContain('nothing to reclaim');
  });

  it('reclaims a long-abandoned row and leaves a recently claimed one running', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const stranded = seedRunning(dataDir, 'Movies', 40 * 60 * 60 * 1000);
    const fresh = seedRunning(dataDir, 'Movies', 30 * 60 * 1000);

    expect(await main(['reap', '--data-dir', dataDir])).toBe(0);
    expect(stateOf(dataDir, stranded)).toBe('held');
    expect(stateOf(dataDir, fresh)).toBe('running');
  });

  it('changes nothing under --dry-run', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const stranded = seedRunning(dataDir, 'Movies', 40 * 60 * 60 * 1000);

    expect(await main(['reap', '--dry-run', '--data-dir', dataDir])).toBe(0);
    expect(stateOf(dataDir, stranded)).toBe('running');
  });

  it('refuses a threshold short enough to reclaim a running transcode', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const stranded = seedRunning(dataDir, 'Movies', 2 * 60 * 60 * 1000);

    expect(await main(['reap', '--stale-after-hours', '0', '--data-dir', dataDir])).not.toBe(0);
    expect(stderr()).toContain('too short');
    expect(stateOf(dataDir, stranded)).toBe('running');
  });
});

describe('cli: forget', () => {
  /** A tracked row for a real file, marked missing after the file is deleted. */
  const seedMissing = (
    dataDir: string,
    libraryName: string,
    name: string,
    state: string,
  ): { fileId: string; path: string } => {
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).getByName(libraryName)!;
    const path = join(library.roots[0]!, name);
    const fileId = `missing-${name}`;
    db.prepare(
      `INSERT INTO media_file (
         id, library_id, content_key, path, size_bytes, mtime_ms, ctime_ms,
         container, state, missing_since_ms, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 'mkv', ?, ?, 0, 0)`,
    ).run(fileId, library.id, `content-${name}`, path, state, 1_700_000_000_000);
    db.prepare(
      `INSERT INTO job (id, file_id, flow_id, flow_hash, state, started_at)
       VALUES (?, ?, 'f', 'h', 'succeeded', 0)`,
    ).run(`job-${name}`, fileId);
    db.close();
    return { fileId, path };
  };

  const rowExists = (dataDir: string, fileId: string): boolean => {
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    const row = db.prepare('SELECT id FROM media_file WHERE id = ?').get(fileId);
    db.close();
    return row !== undefined;
  };

  it('requires something to forget', async () => {
    expect(await main(['forget', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('name what to forget');
  });

  it('forgets a confirmed-missing row, and says the job history goes with it', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const { fileId } = seedMissing(dataDir, 'Movies', 'gone.mkv', 'good');

    expect(await main(['forget', '--missing', '--library', 'Movies', '--data-dir', dataDir])).toBe(
      0,
    );
    expect(stdout()).toContain('job record(s) and their step traces');
    expect(rowExists(dataDir, fileId)).toBe(false);
  });

  it('keeps a terminal row for inspection until it is asked for', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const { fileId } = seedMissing(dataDir, 'Movies', 'failed.mkv', 'failed');

    expect(await main(['forget', '--missing', '--library', 'Movies', '--data-dir', dataDir])).toBe(
      0,
    );
    expect(rowExists(dataDir, fileId)).toBe(true);
    expect(stdout()).toContain('--include-terminal');

    expect(
      await main([
        'forget',
        '--missing',
        '--library',
        'Movies',
        '--include-terminal',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);
    expect(rowExists(dataDir, fileId)).toBe(false);
  });

  it('changes nothing under --dry-run', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const { fileId } = seedMissing(dataDir, 'Movies', 'gone.mkv', 'good');

    expect(
      await main([
        'forget',
        '--missing',
        '--dry-run',
        '--library',
        'Movies',
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);
    expect(stdout()).toContain('Nothing was changed');
    expect(rowExists(dataDir, fileId)).toBe(true);
  });

  it('refuses to forget a row nothing has confirmed missing', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const ids = seedFiles(dataDir, 'Movies', ['queued']);

    expect(await main(['forget', '--file', ids[0]!, '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('not marked missing');
    expect(rowExists(dataDir, ids[0]!)).toBe(true);
  });
});

describe('cli: requeue', () => {
  it('requires something to requeue', async () => {
    expect(await main(['requeue', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('name what to requeue');
  });

  it('rejects an unknown file id by name', async () => {
    expect(await main(['requeue', '--file', 'nope', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('no file with id "nope"');
  });

  it('rejects --state without --library', async () => {
    expect(await main(['requeue', '--state', 'failed', '--data-dir', newDataDir()])).not.toBe(0);
    expect(stderr()).toContain('--state also needs --library');
  });

  it('moves a terminal file back to queued and clears its backoff', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const ids = seedFiles(dataDir, 'Movies', ['not_converging', 'good']);

    expect(await main(['requeue', '--file', ids[0]!, '--data-dir', dataDir])).toBe(0);

    expect(stateOfFile(dataDir, ids[0]!)).toMatchObject({
      state: 'queued',
      attempt_count: 0,
      hold_until_ms: null,
    });
    // Nothing else moved.
    expect(stateOfFile(dataDir, ids[1]!)?.state).toBe('good');
  });

  it('requeues every file in one state within a library', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const ids = seedFiles(dataDir, 'Movies', ['failed', 'failed', 'good']);

    expect(
      await main(['requeue', '--library', 'Movies', '--state', 'failed', '--data-dir', dataDir]),
    ).toBe(0);

    expect(stateOfFile(dataDir, ids[0]!)?.state).toBe('queued');
    expect(stateOfFile(dataDir, ids[1]!)?.state).toBe('queued');
    expect(stateOfFile(dataDir, ids[2]!)?.state).toBe('good');
  });

  it('requeued files become claimable again: "run" picks them up', async () => {
    const dataDir = newDataDir();
    await addLibrary(dataDir, 'Movies');
    const ids = seedFiles(dataDir, 'Movies', ['failed']);

    // Before: a terminal row is invisible to the queue.
    expect(await main(['run', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('Claimed 0 file(s)');
    expect(stateOfFile(dataDir, ids[0]!)?.state).toBe('failed');

    expect(await main(['requeue', '--file', ids[0]!, '--data-dir', dataDir])).toBe(0);
    // After: it is claimed (and stalls at once — the seeded row has no
    // probe — which is exactly the observable proof the queue reached it).
    expect(await main(['run', '--data-dir', dataDir])).toBe(0);
    expect(stateOfFile(dataDir, ids[0]!)?.state).not.toBe('queued');
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

// ---------------------------------------------------------------------------
// plugin sources
// ---------------------------------------------------------------------------

/** Writes <tmp>/p/myPlugin/1.0.0/index.js — the layout `discoverFlowPlugins` looks for. */
const writeFixturePluginTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-plugins-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.js'),
    `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'x',
  style: { borderColor: '#fff' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [{
    label: 'Container',
    name: 'container',
    type: 'string',
    defaultValue: 'mp4',
    tooltip: 'the container to write',
    inputUI: { type: 'text' },
  }],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
`,
    'utf8',
  );
  return root;
};

/** A tree whose only candidate throws on load: the "skipped, and why" path. */
const writeBrokenPluginTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-broken-'));
  const dir = join(root, 'p', 'brokenPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), `throw new Error('deliberately unloadable');\n`, 'utf8');
  return root;
};

/** The plugin rows this data directory really holds — state, not printed text. */
const readPlugins = (dataDir: string) => {
  const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
  migrate(db);
  try {
    const repo = createPluginRepo(db);
    return {
      sources: repo.listSources().map((source) => ({ id: source.id, url: source.url, kind: source.kind, lastSyncedAtMs: source.lastSyncedAtMs })), // prettier-ignore
      pluginIds: repo.listPlugins().map((plugin) => plugin.id),
    };
  } finally {
    db.close();
  }
};

describe('cli: plugin source', () => {
  it('adds a local source and lists it', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    expect(
      await main([
        'plugin',
        'source',
        'add',
        '--name',
        'fx',
        '--path',
        tree,
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);

    // The row, not the sentence: the source is stored as a local one at the
    // path given, and has never been synced.
    expect(readPlugins(dataDir).sources).toEqual([
      { id: 'fx', url: tree, kind: 'local', lastSyncedAtMs: null },
    ]);

    expect(await main(['plugin', 'source', 'list', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('fx');
    expect(stdout()).toContain(tree);
    expect(stdout()).toContain('never synced');
  });

  it('names the consequence of installing when a source is added', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    expect(
      await main([
        'plugin',
        'source',
        'add',
        '--name',
        'fx',
        '--path',
        tree,
        '--data-dir',
        dataDir,
      ]),
    ).toBe(0);
    // Adding a source is the trust decision, so the command that takes it
    // says what it costs rather than leaving it to the documentation.
    expect(stdout()).toContain("runs its author's code");
    expect(stdout()).toContain('the same user trawlarr runs as');
  });

  it('refuses a source named trawlarr, by name', async () => {
    const dataDir = newDataDir();
    expect(
      await main([
        'plugin', 'source', 'add', '--name', 'trawlarr', '--path', '/tmp', '--data-dir', dataDir,
      ]), // prettier-ignore
    ).not.toBe(0);
    expect(stderr()).toMatch(/reserved/i);
    // And nothing was created: a refused name must not leave a row behind.
    expect(existsSync(join(dataDir, 'trawlarr.db'))).toBe(false);
  });

  it('refuses both --url and --path together rather than picking one', async () => {
    const dataDir = newDataDir();
    expect(
      await main([
        'plugin', 'source', 'add', '--name', 'fx',
        '--url', 'https://example.test/x.tar.gz', '--path', '/tmp',
        '--data-dir', dataDir,
      ]), // prettier-ignore
    ).not.toBe(0);
    expect(stderr()).toMatch(/one of/i);
  });

  it('refuses neither --url nor --path', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'source', 'add', '--name', 'fx', '--data-dir', dataDir])).not.toBe(
      0,
    );
    expect(stderr()).toMatch(/one of/i);
  });

  it('refuses a plain-http --url, because this is code it will execute', async () => {
    const dataDir = newDataDir();
    expect(
      await main([
        'plugin', 'source', 'add', '--name', 'fx',
        '--url', 'http://example.test/x.tar.gz', '--data-dir', dataDir,
      ]), // prettier-ignore
    ).not.toBe(0);
    expect(stderr()).toContain('must be an https URL');
    expect(existsSync(join(dataDir, 'trawlarr.db'))).toBe(false);
  });

  it('refuses a --path that is not there, instead of storing a source of nothing', async () => {
    const dataDir = newDataDir();
    const missing = join(tmpdir(), 'trawlarr-cli-no-such-tree-x9');
    expect(
      await main(['plugin', 'source', 'add', '--name', 'fx', '--path', missing, '--data-dir', dataDir]), // prettier-ignore
    ).not.toBe(0);
    expect(stderr()).toContain(missing);
  });

  it('syncs a local source, and the installed plugin appears beside the first-party ones', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', tree, '--data-dir', dataDir]);
    expect(await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir])).toBe(0);

    // The row is what makes the plugin resolvable everywhere else.
    const after = readPlugins(dataDir);
    expect(after.pluginIds).toEqual(['fx:myPlugin']);
    expect(after.sources[0]!.lastSyncedAtMs).not.toBeNull();

    expect(await main(['plugin', 'list', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('fx:myPlugin');
    expect(stdout()).toContain('trawlarr:execute');
  });

  it('syncs every enabled source with --all', async () => {
    const dataDir = newDataDir();
    await main(['plugin', 'source', 'add', '--name', 'one', '--path', writeFixturePluginTree(), '--data-dir', dataDir]); // prettier-ignore
    await main(['plugin', 'source', 'add', '--name', 'two', '--path', writeFixturePluginTree(), '--data-dir', dataDir]); // prettier-ignore
    expect(await main(['plugin', 'source', 'sync', '--all', '--data-dir', dataDir])).toBe(0);
    expect(readPlugins(dataDir).pluginIds).toEqual(['one:myPlugin', 'two:myPlugin']);
  });

  it('prints every skipped plugin and why, so half a source does not look like none', async () => {
    const dataDir = newDataDir();
    await main(['plugin', 'source', 'add', '--name', 'bad', '--path', writeBrokenPluginTree(), '--data-dir', dataDir]); // prettier-ignore
    expect(await main(['plugin', 'source', 'sync', '--name', 'bad', '--data-dir', dataDir])).toBe(
      0,
    );
    expect(readPlugins(dataDir).pluginIds).toEqual([]);
    expect(stdout()).toContain('brokenPlugin');
    expect(stdout()).toContain('deliberately unloadable');
  });

  it('requires --name or --all rather than syncing everything by default', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'source', 'sync', '--data-dir', dataDir])).not.toBe(0);
    expect(stderr()).toContain('--name <source> or --all is required');
  });

  it('names the source that does not exist rather than failing anonymously', async () => {
    const dataDir = newDataDir();
    expect(
      await main(['plugin', 'source', 'sync', '--name', 'nope', '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('nope');
  });

  it('removing a source removes its plugins', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', tree, '--data-dir', dataDir]);
    await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir]);
    expect(readPlugins(dataDir).pluginIds).toEqual(['fx:myPlugin']);

    expect(await main(['plugin', 'source', 'remove', '--name', 'fx', '--data-dir', dataDir])).toBe(
      0,
    );
    // Both rows are gone — the source AND the plugins it installed.
    expect(readPlugins(dataDir)).toEqual({ sources: [], pluginIds: [] });

    logSpy.mockClear();
    await main(['plugin', 'list', '--data-dir', dataDir]);
    expect(stdout()).not.toContain('fx:myPlugin');
  });

  it('says what a flow naming a removed plugin will now do', async () => {
    const dataDir = newDataDir();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', writeFixturePluginTree(), '--data-dir', dataDir]); // prettier-ignore
    await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir]);
    logSpy.mockClear();
    expect(await main(['plugin', 'source', 'remove', '--name', 'fx', '--data-dir', dataDir])).toBe(0); // prettier-ignore
    expect(stdout()).toContain('fx:myPlugin');
    expect(stdout()).toContain('pauses');
  });

  it('names the source that cannot be removed', async () => {
    const dataDir = newDataDir();
    expect(
      await main(['plugin', 'source', 'remove', '--name', 'ghost', '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('ghost');
  });

  it('answers an empty source list with what to do about it', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'source', 'list', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('No plugin sources');
  });

  it('names the unknown plugin subcommand', async () => {
    expect(await main(['plugin', 'frobnicate'])).not.toBe(0);
    expect(stderr()).toContain('Unknown command: "plugin frobnicate".');
    expect(await main(['plugin', 'source', 'frobnicate'])).not.toBe(0);
    expect(stderr()).toContain('Unknown command: "plugin source frobnicate".');
  });
});

describe('cli: plugin list / show', () => {
  it('lists the first-party plugins with no source added at all', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'list', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('trawlarr:start');
    expect(stdout()).toContain('trawlarr:execute');
    expect(stdout()).toContain('No plugins installed from a source yet');
  });

  it('restricts the listing to one source, and names an unknown one', async () => {
    const dataDir = newDataDir();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', writeFixturePluginTree(), '--data-dir', dataDir]); // prettier-ignore
    await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir]);
    logSpy.mockClear();

    expect(await main(['plugin', 'list', '--source', 'fx', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('fx:myPlugin');
    expect(stdout()).not.toContain('trawlarr:execute');

    expect(await main(['plugin', 'list', '--source', 'other', '--data-dir', dataDir])).not.toBe(0);
    expect(stderr()).toContain('no plugin source "other"');
    expect(stderr()).toContain('fx');
  });

  it("shows an installed plugin's inputs with defaults and outputs with tooltips", async () => {
    const dataDir = newDataDir();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', writeFixturePluginTree(), '--data-dir', dataDir]); // prettier-ignore
    await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir]);
    logSpy.mockClear();

    expect(await main(['plugin', 'show', '--id', 'fx:myPlugin', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('Fixture Plugin');
    expect(stdout()).toContain('container');
    expect(stdout()).toContain('"mp4"'); // the default a flow gets by omitting it
    expect(stdout()).toContain('the container to write');
    expect(stdout()).toContain('ok'); // the output tooltip an edge is chosen by
  });

  it('shows a first-party plugin without any source at all', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'show', '--id', 'trawlarr:execute', '--data-dir', dataDir])).toBe(0); // prettier-ignore
    expect(stdout()).toContain('trawlarr:execute');
    expect(stdout()).toContain('Outputs (');
  });

  it('refuses an id nothing here can resolve, saying what the shapes are', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'show', '--id', 'nope:missing', '--data-dir', dataDir])).not.toBe(0); // prettier-ignore
    expect(stderr()).toContain('nope:missing');
    expect(stderr()).toContain('needs its source added and synced');
  });

  it('requires --id', async () => {
    const dataDir = newDataDir();
    expect(await main(['plugin', 'show', '--data-dir', dataDir])).not.toBe(0);
    expect(stderr()).toContain('--id is required');
  });
});
