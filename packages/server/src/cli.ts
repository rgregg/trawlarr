#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLibraryRepo, DEFAULT_EXTENSIONS } from './db/library-repo.js';
import { createFlowRepo } from './db/flow-repo.js';
import { createMediaFileRepo } from './db/media-file-repo.js';
import { scanLibrary } from './scanner/scan-library.js';
import { runQueue } from './worker/loop.js';

/** Raised by a command handler to report a clean, diagnosable failure — never a raw stack trace. */
class CliError extends Error {}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Opens (creating if needed) the database this invocation's `--data-dir` points at, migrated. */
const openDb = async (dataDir: string): Promise<Db> => {
  const dir = resolve(dataDir);
  await mkdir(dir, { recursive: true });
  const db = openDatabase({ file: join(dir, 'trawlarr.db') });
  migrate(db);
  return db;
};

const requireLibrary = (db: Db, name: string) => {
  const library = createLibraryRepo(db).getByName(name);
  if (library === null) throw new CliError(`Unknown library: "${name}". Run "library add" first.`);
  return library;
};

const requireFlow = (db: Db, name: string) => {
  const flow = createFlowRepo(db).getByName(name);
  if (flow === null) throw new CliError(`Unknown flow: "${name}". Run "flow add" first.`);
  return flow;
};

// ---------------------------------------------------------------------------
// library add
// ---------------------------------------------------------------------------

const cmdLibraryAdd = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      name: { type: 'string' },
      root: { type: 'string', multiple: true },
      extensions: { type: 'string' },
      'allow-hardlinked': { type: 'boolean', default: false },
    },
  });

  if (values.name === undefined) throw new CliError('library add: --name is required.');
  if (values.root === undefined || values.root.length === 0) {
    throw new CliError('library add: at least one --root is required.');
  }

  const db = await openDb(values['data-dir']!);
  const extensions =
    values.extensions !== undefined
      ? values.extensions
          .split(',')
          .map((ext) => ext.trim())
          .filter((ext) => ext.length > 0)
      : [...DEFAULT_EXTENSIONS];

  const library = createLibraryRepo(db).create({
    name: values.name,
    roots: values.root,
    extensions,
    allowHardlinked: values['allow-hardlinked'],
    nowMs: Date.now(),
  });

  console.log(
    `Added library "${library.name}" (${library.id}) with ${library.roots.length} root(s): ` +
      library.roots.join(', '),
  );
  return 0;
};

// ---------------------------------------------------------------------------
// flow add
// ---------------------------------------------------------------------------

const cmdFlowAdd = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      name: { type: 'string' },
      file: { type: 'string' },
    },
  });

  if (values.name === undefined) throw new CliError('flow add: --name is required.');
  if (values.file === undefined) throw new CliError('flow add: --file is required.');

  let definition: FlowDefinition;
  try {
    const text = await readFile(values.file, 'utf8');
    definition = JSON.parse(text) as FlowDefinition;
  } catch (err) {
    throw new CliError(`flow add: could not read/parse "${values.file}": ${messageOf(err)}`);
  }

  const db = await openDb(values['data-dir']!);
  const flow = createFlowRepo(db).create({ name: values.name, definition, nowMs: Date.now() });
  console.log(`Added flow "${flow.name}" (${flow.id}), ${flow.definition.nodes.length} node(s).`);
  return 0;
};

// ---------------------------------------------------------------------------
// library set-flow
// ---------------------------------------------------------------------------

const cmdLibrarySetFlow = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      library: { type: 'string' },
      flow: { type: 'string' },
    },
  });

  if (values.library === undefined) throw new CliError('library set-flow: --library is required.');
  if (values.flow === undefined) throw new CliError('library set-flow: --flow is required.');

  const db = await openDb(values['data-dir']!);
  const library = requireLibrary(db, values.library);
  const flow = requireFlow(db, values.flow);

  createLibraryRepo(db).setFlow(library.id, flow.id);
  console.log(`Library "${library.name}" now uses flow "${flow.name}".`);
  return 0;
};

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

const cmdScan = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      library: { type: 'string' },
      ffprobe: { type: 'string', default: 'ffprobe' },
    },
  });

  if (values.library === undefined) throw new CliError('scan: --library is required.');

  const db = await openDb(values['data-dir']!);
  const library = requireLibrary(db, values.library);

  const summary = await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: values.ffprobe!,
    nowMs: Date.now,
  });

  // `updated` counts rows the upsert TOUCHED, not rows that changed — a
  // no-op rescan still reports it — so it is deliberately not printed here.
  // `probed` is the honest "expensive work actually happened" count.
  console.log(
    `Library "${library.name}": found ${summary.seen} file(s), ${summary.added} new, ` +
      `probed ${summary.probed}, queued ${summary.queued}, ${summary.alreadyGood} already good, ` +
      `${summary.skippedHardlinked} skipped (hardlinked), ${summary.unreadable} unreadable/conflicted.`,
  );
  return 0;
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const cmdRun = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      library: { type: 'string' },
      max: { type: 'string' },
      ffmpeg: { type: 'string', default: 'ffmpeg' },
      ffprobe: { type: 'string', default: 'ffprobe' },
    },
  });

  const db = await openDb(values['data-dir']!);

  // `libraryIds: []` means "claim nothing" to runQueue, so an unspecified
  // `--library` must pass `undefined` (no filter), never an empty array.
  let libraryIds: string[] | undefined;
  if (values.library !== undefined) {
    const library = requireLibrary(db, values.library);
    libraryIds = [library.id];
  }

  let maxFiles: number | undefined;
  if (values.max !== undefined) {
    maxFiles = Number.parseInt(values.max, 10);
    if (!Number.isFinite(maxFiles) || maxFiles < 0) {
      throw new CliError(`run: --max must be a non-negative integer, got "${values.max}".`);
    }
  }

  const summary = await runQueue({
    db,
    ffmpegPath: values.ffmpeg!,
    ffprobePath: values.ffprobe!,
    nowMs: Date.now,
    libraryIds,
    maxFiles,
    onFile: (event) => {
      console.log(`  ${event.path} -> ${event.state}`);
    },
  });

  console.log(
    `Claimed ${summary.claimed} file(s): ${summary.succeeded} succeeded, ` +
      `${summary.heldForRetry} held (will retry once their backoff expires), ` +
      `${summary.notConverging} not_converging (terminal, needs review), ` +
      `${summary.failed} failed.`,
  );
  if (summary.failed > 0) {
    console.log(
      `  Note: a "failed" count here can include a file whose attempt threw before any ` +
        `outcome was recorded; such a row may be left "running" with no automatic retry — ` +
        `check "status" and consider a manual requeue.`,
    );
  }
  if (summary.pausedSkipped > 0) {
    console.log(
      `  ${summary.pausedSkipped} file(s) left untouched in paused libraries this drain.`,
    );
  }
  return 0;
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const cmdStatus = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      library: { type: 'string' },
    },
  });

  const db = await openDb(values['data-dir']!);
  const libraryRepo = createLibraryRepo(db);
  const mediaFileRepo = createMediaFileRepo(db);

  const libraries =
    values.library !== undefined ? [requireLibrary(db, values.library)] : libraryRepo.list();

  if (libraries.length === 0) {
    console.log('No libraries configured.');
    return 0;
  }

  for (const library of libraries) {
    const counts = mediaFileRepo.countsByState(library.id);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const pct = total === 0 ? 0 : Math.round((counts.good / total) * 100);
    console.log(
      `${library.name}: ${total} file(s) — good ${counts.good}, queued ${counts.queued}, ` +
        `held ${counts.held}, running ${counts.running}, failed ${counts.failed}, ` +
        `not_converging ${counts.not_converging}, unknown ${counts.unknown} ` +
        `(${pct}% converged)`,
    );
  }
  return 0;
};

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  trawlarr library add --name <name> --root <path> [--root <path>...] [--extensions mkv,mp4] [--allow-hardlinked]
  trawlarr flow add --name <name> --file <flow.json>
  trawlarr library set-flow --library <name> --flow <name>
  trawlarr scan --library <name>
  trawlarr run [--library <name>] [--max <n>]
  trawlarr status [--library <name>]

All commands accept --data-dir <path> (default ./trawlarr-data).`;

const dispatch = async (argv: string[]): Promise<number> => {
  const [cmd, ...rest] = argv;

  if (cmd === 'library') {
    const [sub, ...subRest] = rest;
    if (sub === 'add') return cmdLibraryAdd(subRest);
    if (sub === 'set-flow') return cmdLibrarySetFlow(subRest);
    throw new CliError(`Unknown command: "library ${sub ?? ''}".\n\n${USAGE}`);
  }
  if (cmd === 'flow') {
    const [sub, ...subRest] = rest;
    if (sub === 'add') return cmdFlowAdd(subRest);
    throw new CliError(`Unknown command: "flow ${sub ?? ''}".\n\n${USAGE}`);
  }
  if (cmd === 'scan') return cmdScan(rest);
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);

  console.error(USAGE);
  return cmd === undefined ? 2 : 2;
};

export const main = async (argv: string[]): Promise<number> => {
  try {
    return await dispatch(argv);
  } catch (err) {
    // Every failure surfaces as a diagnosable one-line message, never a raw
    // stack trace: a CliError already carries exactly the message meant for
    // a user, and anything else (a domain error thrown by the repos/scanner/
    // worker — unknown library, overlapping roots, a bad flow file, ...)
    // still has a real `.message` worth showing on its own.
    console.error(`Error: ${messageOf(err)}`);
    return 1;
  }
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === `file://${resolve(entry)}`;
};

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`Error: ${messageOf(err)}`);
      process.exitCode = 1;
    },
  );
}
