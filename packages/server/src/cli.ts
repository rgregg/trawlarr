#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileState, FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLibraryRepo, DEFAULT_EXTENSIONS, type LibraryRecord } from './db/library-repo.js';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  purgeTrash,
  trashRetentionDaysForFlow,
} from './library/trash.js';
import { createFlowRepo } from './db/flow-repo.js';
import { ALL_STATES, createMediaFileRepo } from './db/media-file-repo.js';
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

/**
 * `library`/`flow` names are UNIQUE at the schema level, so a duplicate
 * `add` would otherwise surface as a raw `UNIQUE constraint failed:
 * flow.name` SqliteError — technically diagnosable, but not in the terms a
 * user typed. Checked up front so the CLI's own error, not sqlite's, is
 * what a duplicate name gets.
 */
const requireNameAvailable = (input: {
  kind: 'library' | 'flow';
  existing: { id: string } | null;
  name: string;
}): void => {
  if (input.existing !== null) {
    throw new CliError(`${input.kind} add: a ${input.kind} named "${input.name}" already exists.`);
  }
};

/**
 * Extensions the way a user is most likely to type them wrong: a leading
 * dot (`.mkv` instead of `mkv`) is normalised away rather than producing a
 * library that can never match a real file's extname; an empty/blank list
 * (`--extensions ""`, or `--extensions " , "`) is rejected outright, for
 * the same reason.
 */
const parseExtensions = (raw: string): string[] => {
  const extensions = raw
    .split(',')
    .map((ext) => ext.trim().replace(/^\.+/, '').toLowerCase())
    .filter((ext) => ext.length > 0);
  if (extensions.length === 0) {
    throw new CliError(
      `library add: --extensions "${raw}" contained no usable extension. Write them without a ` +
        `leading dot, comma-separated (e.g. "mkv,mp4"), or omit --extensions to use the default set.`,
    );
  }
  return extensions;
};

/**
 * A `--state` value the user typed, checked against the real state vocabulary
 * rather than passed through to a query that would silently match nothing.
 */
const parseState = (raw: string, label: string): FileState => {
  const match = ALL_STATES.find((state) => state === raw);
  if (match === undefined) {
    throw new CliError(
      `${label}: "${raw}" is not a file state. Valid states: ${ALL_STATES.join(', ')}.`,
    );
  }
  return match;
};

/** A whole non-negative integer, rejecting "3abc"-style inputs `parseInt` would silently accept. */
const parseNonNegativeInt = (raw: string, label: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new CliError(`${label} must be a non-negative integer, got "${raw}".`);
  }
  return Number.parseInt(raw, 10);
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
  requireNameAvailable({
    kind: 'library',
    existing: createLibraryRepo(db).getByName(values.name),
    name: values.name,
  });
  const extensions =
    values.extensions !== undefined ? parseExtensions(values.extensions) : [...DEFAULT_EXTENSIONS];

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
  requireNameAvailable({
    kind: 'flow',
    existing: createFlowRepo(db).getByName(values.name),
    name: values.name,
  });
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
      'allow-empty-roots': { type: 'boolean', default: false },
    },
  });

  if (values.library === undefined) throw new CliError('scan: --library is required.');

  const db = await openDb(values['data-dir']!);
  const library = requireLibrary(db, values.library);
  if (library.flowId === null) {
    throw new CliError(
      `Library "${library.name}" has no flow attached, so a scan cannot queue anything for it. ` +
        `Run "library set-flow --library ${library.name} --flow <name>" first.`,
    );
  }

  const summary = await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: values.ffprobe!,
    nowMs: Date.now,
    allowEmptyRoots: values['allow-empty-roots'],
  });

  // `updated` counts rows the upsert TOUCHED, not rows that changed — a
  // no-op rescan still reports it — so it is deliberately not printed here.
  // `probed` is the honest "expensive work actually happened" count.
  console.log(
    `Library "${library.name}": found ${summary.seen} file(s), ${summary.added} new, ` +
      `probed ${summary.probed}, queued ${summary.queued}, ${summary.alreadyGood} already good, ` +
      `${summary.skippedHardlinked} skipped (hardlinked), ${summary.unreadable} unreadable/conflicted.`,
  );
  if (summary.inFlight > 0) {
    console.log(
      `  ${summary.inFlight} file(s) left to a run currently in flight; they are recorded by ` +
        `that run and picked up by the next scan.`,
    );
  }
  if (summary.missing > 0 || summary.restored > 0) {
    console.log(
      `  ${summary.missing} file(s) gone from disk (their rows are kept, with their history, ` +
        `but no longer count towards convergence and are never claimed), ` +
        `${summary.restored} came back.`,
    );
  }
  // The loudest line the scan can print, because it is the one that explains
  // why the numbers above are smaller than the library really is — and the
  // reason nothing was marked missing under that root.
  if (summary.rootsUnavailable > 0) {
    console.log(
      `  WARNING: ${summary.rootsUnavailable} of this library's ${library.roots.length} root(s) ` +
        `could not be shown to be present (missing, unreadable, or empty — which is what an ` +
        `unmounted network share looks like). Nothing under them was reconciled, so no file ` +
        `was marked gone on the strength of a mount that may simply be offline. If a root ` +
        `really is empty now, re-run with --allow-empty-roots.`,
    );
  }
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

  const maxFiles =
    values.max !== undefined ? parseNonNegativeInt(values.max, 'run: --max') : undefined;

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
        `find it with "trawlarr status --files" and recover it with ` +
        `"trawlarr requeue --file <id>".`,
    );
  }
  if (summary.pausedSkipped > 0) {
    console.log(
      `  ${summary.pausedSkipped} file(s) left untouched in paused libraries this drain.`,
    );
  }

  // The drain is the thing that FILLS the trash, so it is also what empties
  // it: without this, `trashRetentionDays` would only take effect for
  // someone who knew to run `trawlarr trash purge` by hand, and a library
  // being transcoded wholesale accumulates a full copy of every original.
  // Run AFTER the drain, never during it: an in-flight replacement's
  // recovery path is the trash.
  //
  // Quiet unless it actually removed something — a `run` that transcoded
  // nothing should not print a paragraph about a trash that was already
  // empty. A sweep failure must not fail the drain that already succeeded.
  const sweepTargets =
    values.library !== undefined
      ? [requireLibrary(db, values.library)]
      : createLibraryRepo(db).list();
  for (const library of sweepTargets) {
    try {
      await sweepLibraryTrash(db, library, { quiet: true });
    } catch (err) {
      console.log(`  Trash sweep for "${library.name}" did not run: ${messageOf(err)}`);
    }
  }
  return 0;
};

// ---------------------------------------------------------------------------
// trash purge
// ---------------------------------------------------------------------------

/**
 * Sweep one library's trash, reporting what went.
 *
 * The retention comes from the library's own flow — the `trashRetentionDays`
 * input on its Replace Original File node(s) — so the setting a user typed
 * into the flow is the setting that takes effect, which is exactly what was
 * missing while nothing read it. `--days` overrides it for one invocation.
 */
const sweepLibraryTrash = async (
  db: Db,
  library: LibraryRecord,
  options: { days?: number; dryRun?: boolean; quiet?: boolean },
): Promise<void> => {
  const flow = library.flowId === null ? null : createFlowRepo(db).getById(library.flowId);
  const retentionDays =
    options.days ??
    (flow === null ? DEFAULT_TRASH_RETENTION_DAYS : trashRetentionDaysForFlow(flow.definition));

  const summary = await purgeTrash({
    library,
    retentionDays,
    nowMs: Date.now(),
    dryRun: options.dryRun,
  });

  if (options.quiet === true && summary.removed === 0 && summary.failed === 0) return;

  const verb = options.dryRun === true ? 'would remove' : 'removed';
  console.log(
    `Trash for "${library.name}" (retention ${retentionDays} day(s)): ${verb} ` +
      `${summary.removed} file(s), ${formatBytes(summary.bytesFreed)}; ${summary.retained} still ` +
      `within retention, ${summary.skipped} left alone (not trawlarr trash entries).`,
  );
  if (summary.failed > 0) {
    console.log(`  ${summary.failed} entr(ies) could not be removed; check permissions.`);
  }
  if (summary.dirsRefused > 0) {
    console.log(
      `  ${summary.dirsRefused} configured trash director(ies) contain a library root and were ` +
        `refused: sweeping one would delete library files. Point trashDir somewhere that does ` +
        `not contain a root.`,
    );
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]!}`;
};

const cmdTrashPurge = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      library: { type: 'string' },
      days: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const db = await openDb(values['data-dir']!);
  const days =
    values.days === undefined ? undefined : parseNonNegativeInt(values.days, 'trash purge: --days');

  const libraries =
    values.library !== undefined
      ? [requireLibrary(db, values.library)]
      : createLibraryRepo(db).list();
  if (libraries.length === 0) {
    console.log('No libraries configured.');
    return 0;
  }

  for (const library of libraries) {
    await sweepLibraryTrash(db, library, { days, dryRun: values['dry-run'] });
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
      files: { type: 'boolean', default: false },
      state: { type: 'string' },
      missing: { type: 'boolean', default: false },
    },
  });

  const db = await openDb(values['data-dir']!);
  const libraryRepo = createLibraryRepo(db);
  const mediaFileRepo = createMediaFileRepo(db);

  if (values.missing && values.state !== undefined) {
    throw new CliError(
      'status: use either --missing or --state, not both. --missing lists the files that are ' +
        'gone from disk, whatever ledger state each row was left in.',
    );
  }

  const stateFilter =
    values.state === undefined ? undefined : parseState(values.state, 'status: --state');
  // `--state`/`--missing` on their own are only meaningful as filters on the
  // file list, so each implies `--files` rather than silently printing the
  // same summary.
  const showFiles = values.files || stateFilter !== undefined || values.missing;

  const libraries =
    values.library !== undefined ? [requireLibrary(db, values.library)] : libraryRepo.list();

  if (libraries.length === 0) {
    console.log('No libraries configured.');
    return 0;
  }

  for (const library of libraries) {
    const counts = mediaFileRepo.countsByState(library.id);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    // Deliberately outside `total`: `countsByState` already excludes these,
    // and a file that no longer exists can never reach `good`, so counting
    // it would cap the percentage below 100% forever for a file the user
    // deleted on purpose. Reported on its own line instead of hidden.
    const missing = mediaFileRepo.missingCount(library.id);

    // A library that has never been scanned — or whose roots point
    // somewhere with no matching media — has no percentage to report, and
    // printing "0 file(s) ... (0% converged)" reads as a failure for what
    // is very often the first command a new user runs. Say what actually
    // happened, and what to do next, instead.
    if (total === 0 && missing === 0) {
      console.log(
        `${library.name}: no files tracked yet. Roots: ${library.roots.join(', ')}. ` +
          `Run "trawlarr scan --library ${library.name}" — if that still finds nothing, ` +
          `check the roots above and --extensions (currently ` +
          `${library.extensions.join(', ')}).`,
      );
      continue;
    }

    // Floored, not rounded: rounding up would let a library with files
    // still queued read "100% converged", the one number this project's
    // counter-honesty rule cannot let overstate. 100% is reserved for
    // `good === total` exactly.
    const pct = total === 0 ? 0 : Math.floor((counts.good / total) * 100);
    console.log(
      `${library.name}: ${total} file(s) — good ${counts.good}, queued ${counts.queued}, ` +
        `held ${counts.held}, running ${counts.running}, failed ${counts.failed}, ` +
        `not_converging ${counts.not_converging}, unknown ${counts.unknown} ` +
        `(${pct}% converged)`,
    );

    if (missing > 0) {
      console.log(
        `  ${missing} file(s) are gone from disk. Their rows (and job history) are kept and ` +
          `excluded from the count above; putting a file back makes the next scan pick it up ` +
          `exactly where it left off. List them with "trawlarr status --library ` +
          `${library.name} --missing".`,
      );
    }

    const stuck = counts.failed + counts.not_converging;
    if (stuck > 0 && !showFiles) {
      console.log(
        `  ${stuck} file(s) are in a terminal state and will not be retried on their own. ` +
          `List them with "trawlarr status --library ${library.name} --files --state failed" ` +
          `(or --state not_converging), then "trawlarr requeue --file <id>".`,
      );
    }

    // File ids are what `requeue` takes, and nothing else printed them:
    // the documented recovery path named a row the user had no way to
    // name back.
    if (showFiles) {
      const rows = (
        values.missing
          ? mediaFileRepo.listMissing(library.id)
          : mediaFileRepo.listByLibrary({ libraryId: library.id, state: stateFilter })
      ).sort((a, b) => a.path.localeCompare(b.path));
      if (rows.length === 0) {
        console.log(
          values.missing
            ? '  (no files missing from disk)'
            : stateFilter === undefined
              ? '  (no files)'
              : `  (no files in state "${stateFilter}")`,
        );
      }
      for (const row of rows) {
        // The marker matters on the unfiltered listing too: a `queued` row
        // whose file is gone is never going to be claimed, and nothing else
        // in this line says so.
        const gone =
          row.missing_since_ms === null
            ? ''
            : `  MISSING since ${new Date(row.missing_since_ms).toISOString()}`;
        console.log(
          `  ${row.id}  ${row.state.padEnd(15)} attempts ${row.attempt_count}  ${row.path}${gone}`,
        );
      }
    }
  }
  return 0;
};

// ---------------------------------------------------------------------------
// requeue
// ---------------------------------------------------------------------------

/**
 * The documented recovery path for `failed`, `not_converging`, a row left
 * `running` by a worker that died, and a duplicate-identity stall — all of
 * which are terminal (or invisible) to the scanner and the queue by design.
 * `mediaFileRepo.requeue` has always implemented it; until now nothing
 * outside the tests could call it, so every one of those messages pointed at
 * a command that did not exist.
 */
const cmdRequeue = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: './trawlarr-data' },
      file: { type: 'string', multiple: true },
      library: { type: 'string' },
      state: { type: 'string' },
    },
  });

  const byFile = values.file !== undefined && values.file.length > 0;
  const byState = values.state !== undefined;

  if (!byFile && !byState) {
    throw new CliError(
      'requeue: name what to requeue — either "--file <id>" (repeatable, ids come from ' +
        '"trawlarr status --files") or "--library <name> --state <state>".',
    );
  }
  if (byFile && byState) {
    throw new CliError('requeue: use either --file or --state, not both.');
  }
  if (byState && values.library === undefined) {
    throw new CliError(
      'requeue: --state also needs --library, to say which library to scope it to.',
    );
  }

  const db = await openDb(values['data-dir']!);
  const mediaFileRepo = createMediaFileRepo(db);

  const targets = byFile
    ? values.file!.map((id) => {
        const row = mediaFileRepo.getById(id);
        if (row === null) {
          throw new CliError(
            `requeue: no file with id "${id}". Ids come from "trawlarr status --files".`,
          );
        }
        return row;
      })
    : mediaFileRepo.listByLibrary({
        libraryId: requireLibrary(db, values.library!).id,
        state: parseState(values.state!, 'requeue: --state'),
      });

  if (targets.length === 0) {
    console.log(`No files in state "${values.state!}" in library "${values.library!}".`);
    return 0;
  }

  for (const row of targets) {
    mediaFileRepo.requeue(row.id);
    // Requeueing a row whose file is gone is legal (the ledger state really
    // does go back to `queued`) but does nothing until the file returns,
    // since `claimNext` skips missing rows. Saying so beats a user watching
    // "trawlarr run" claim nothing and finding no explanation anywhere.
    const gone =
      row.missing_since_ms === null
        ? ''
        : '  (file is gone from disk; it will not be claimed until it comes back)';
    console.log(`  ${row.path}: ${row.state} -> queued${gone}`);
  }
  console.log(
    `Requeued ${targets.length} file(s). Run "trawlarr run" to work through them ` +
      `(a requeued file is claimed immediately: its attempt count and backoff are cleared).`,
  );
  return 0;
};

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  trawlarr library add --name <name> --root <path> [--root <path>...] [--extensions mkv,mp4] [--allow-hardlinked]
  trawlarr flow add --name <name> --file <flow.json>
  trawlarr library set-flow --library <name> --flow <name>
  trawlarr scan --library <name> [--allow-empty-roots]
  trawlarr run [--library <name>] [--max <n>]
  trawlarr status [--library <name>] [--files] [--state <state>] [--missing]
  trawlarr requeue --file <id> [--file <id>...]
  trawlarr requeue --library <name> --state <state>
  trawlarr trash purge [--library <name>] [--days <n>] [--dry-run]

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
  if (cmd === 'trash') {
    const [sub, ...subRest] = rest;
    if (sub === 'purge') return cmdTrashPurge(subRest);
    throw new CliError(`Unknown command: "trash ${sub ?? ''}".\n\n${USAGE}`);
  }
  if (cmd === 'scan') return cmdScan(rest);
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'requeue') return cmdRequeue(rest);

  if (cmd === undefined) throw new CliError(`No command given.\n\n${USAGE}`);
  if (cmd.startsWith('-')) {
    // Every option (`--data-dir` included) belongs to a SUBCOMMAND's own
    // parseArgs call, never to a global pass before it — `trawlarr
    // --data-dir X library add ...` would otherwise fall through to the
    // generic "unknown command" message below without saying why.
    throw new CliError(
      `Unrecognized option "${cmd}" where a command was expected. Options — including ` +
        `--data-dir — must come AFTER the command, e.g. "trawlarr scan --library Movies ` +
        `--data-dir ./trawlarr-data".\n\n${USAGE}`,
    );
  }
  throw new CliError(`Unknown command: "${cmd}".\n\n${USAGE}`);
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

/**
 * True only when THIS module is the process's actual entry point — as
 * opposed to being `import`ed by a test that wants `main` without the
 * side effect of it also running.
 *
 * A raw `file://${resolve(entry)}` comparison (the first version of this
 * check) breaks the moment the process was launched through a symlink: a
 * normal global install (`pnpm add -g`) makes the `trawlarr` bin a
 * SYMLINK into `node_modules/.bin`, so `process.argv[1]` is the symlink's
 * path while Node resolves `import.meta.url` through it to the real file
 * — the two strings never match, this returns false, and the installed
 * command prints nothing and exits 0. `realpathSync` resolves the symlink
 * on the `argv[1]` side before comparing, and `pathToFileURL` (rather than
 * a hand-built `file://` template) applies the same percent-encoding
 * `import.meta.url` already carries, so a path containing a space or `#`
 * compares correctly too.
 */
const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false; // argv[1] does not exist on disk: cannot be this file.
  }
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
