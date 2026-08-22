#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FlowValidationError, type FileState, type FlowDefinition } from '@trawlarr/core';
import { createPluginLoader } from '@trawlarr/engine';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import type { PluginDetails } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createLibraryRepo, DEFAULT_EXTENSIONS } from './db/library-repo.js';
import { sweepLibraryTrash as sweepTrashForLibrary } from './library/trash-sweep.js';
import type { LibraryTrashSweep } from './library/trash-sweep.js';
import { explainPause } from './library/pause-explanation.js';
import { createFlowRepo } from './db/flow-repo.js';
import { buildFromTemplate, FLOW_TEMPLATES } from './flow/templates.js';
import { ALL_STATES, createMediaFileRepo } from './db/media-file-repo.js';
import { scanLibrary } from './scanner/scan-library.js';
import { createSettingsRepo } from './db/settings-repo.js';
import { forgetMissing, type ForgetSummary } from './scanner/forget-missing.js';
import { runQueue } from './worker/loop.js';
import { DEFAULT_STALE_AFTER_MS, reapStalled, type ReapSummary } from './worker/reap-stalled.js';
import { startDaemon } from './daemon/daemon.js';
import { DaemonAlreadyRunningError, readDaemonRecord } from './daemon/lockfile.js';
import type { DaemonRecord } from './daemon/lockfile.js';
import { ApiRequestError, createCliClient, type CliClient } from './cli-client.js';
import { createPluginRepo, PluginRepoError, type PluginRepo } from './plugins/plugin-repo.js';
import { assertValidSourceSlug, PluginIdError } from './plugins/plugin-id.js';
import { syncSource } from './plugins/sync-source.js';
import { PLUGIN_TRUST_CONSEQUENCE } from './plugins/trust.js';

/** Raised by a command handler to report a clean, diagnosable failure — never a raw stack trace. */
class CliError extends Error {}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// daemon-or-direct
// ---------------------------------------------------------------------------

/**
 * Who owns this data directory: a running daemon, or nobody.
 *
 * THIS IS THE ROUTING DECISION, and it is made from one fact — the lock file
 * `<data-dir>/daemon.json` and whether the pid it names still exists. A LIVE
 * daemon holds the SQLite file open and is claiming from the same queue, so
 * the CLI becomes its client and never opens the database. A DEAD pid is
 * taken over rather than obeyed: a daemon killed with SIGKILL leaves its lock
 * behind, and treating that as ownership would mean one crash locks the user
 * out of their own installation.
 */
const resolveDaemon = async (dataDir: string): Promise<DaemonRecord | null> =>
  await readDaemonRecord({ dataDir: resolve(dataDir) });

/**
 * The message a command gets when it needs the database a live daemon owns.
 *
 * Specific, and it names the pid: "database is locked" is what the user would
 * otherwise eventually see, from sqlite, about a situation trawlarr already
 * knew everything about.
 */
const notWhileDaemonRuns = (record: DaemonRecord, input: { what: string; instead: string }) =>
  new CliError(
    `${input.what} while the trawlarr daemon (pid ${String(record.pid)}) owns this data ` +
      `directory — it holds the database open and is claiming from the same queue, and a second ` +
      `process writing there would race it: two workers on one file is how a replacement ` +
      `destroys data. ${input.instead}`,
  );

/**
 * Opens (creating if needed) the database this invocation's `--data-dir`
 * points at, migrated — and refuses outright while a daemon owns it.
 *
 * The refusal lives HERE rather than only in each command, so a command that
 * has not been taught to route through the API fails with a sentence naming
 * the daemon instead of quietly becoming a second writer.
 */
const openDb = async (dataDir: string): Promise<Db> => {
  const dir = resolve(dataDir);
  const record = await resolveDaemon(dir);
  if (record !== null) {
    throw notWhileDaemonRuns(record, {
      what: 'This command needs the database directly, which it cannot have',
      instead:
        `Stop the daemon (Ctrl-C, or "systemctl stop trawlarr") and run this again, or use the ` +
        `daemon's own API at http://${record.bind}:${String(record.port)}/api/v1.`,
    });
  }
  await mkdir(dir, { recursive: true });
  const db = openDatabase({ file: join(dir, 'trawlarr.db') });
  migrate(db);
  return db;
};

/**
 * The daemon's error, as the CLI's error.
 *
 * An `ApiError`'s message was written for exactly this reader, so it is
 * surfaced verbatim — a second wording here would drift from the API's, and
 * the two would eventually disagree about the same refusal.
 */
const asCliError = (error: unknown, label: string): never => {
  if (error instanceof ApiRequestError) throw new CliError(`${label}: ${error.message}`);
  throw error;
};

// ---------------------------------------------------------------------------
// resources, as the API reports them
// ---------------------------------------------------------------------------

interface LibraryResource {
  id: string;
  name: string;
  roots: string[];
  extensions: string[];
  flowId: string | null;
  enabled: boolean;
  paused: boolean;
  pausedReason: string | null;
  pausedExplanation: string | null;
}

interface FlowResource {
  id: string;
  name: string;
  definition: FlowDefinition;
}

interface FileResource {
  id: string;
  path: string;
  state: FileState;
  attemptCount: number;
  missingSinceMs: number | null;
}

interface FilePage {
  total: number;
  items: FileResource[];
}

interface StatsResource {
  total: number;
  byState: Record<FileState, number>;
  missing: number;
}

/** Page size for the CLI's own listings: the API's cap, so a listing is one call per 500 rows. */
const PAGE_SIZE = 500;

/**
 * Every file matching a filter, paged.
 *
 * `GET /files` is capped (a listing that returns a whole library holds the
 * daemon's single writer thread while it serialises), so the CLI — which
 * really does print every matching row — pages rather than asking for a
 * number the daemon would refuse.
 */
const fetchAllFiles = async (
  client: CliClient,
  filter: { libraryId: string; state?: FileState; missing?: boolean },
): Promise<FileResource[]> => {
  const items: FileResource[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      libraryId: filter.libraryId,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (filter.state !== undefined) query.set('state', filter.state);
    if (filter.missing !== undefined) query.set('missing', String(filter.missing));
    const page = await client.get<FilePage>(`/files?${query.toString()}`);
    items.push(...page.items);
    if (items.length >= page.total || page.items.length === 0) return items;
  }
};

const requireLibrary = (db: Db, name: string) => {
  const library = createLibraryRepo(db).getByName(name);
  if (library === null) throw new CliError(`Unknown library: "${name}". Run "library add" first.`);
  return library;
};

/** The same message `requireLibrary` produces, against the daemon's own listing. */
const requireLibraryResource = (libraries: LibraryResource[], name: string): LibraryResource => {
  const library = libraries.find((candidate) => candidate.name === name);
  if (library === undefined) {
    throw new CliError(`Unknown library: "${name}". Run "library add" first.`);
  }
  return library;
};

const requireFlow = (db: Db, name: string) => {
  const flow = createFlowRepo(db).getByName(name);
  if (flow === null) throw new CliError(`Unknown flow: "${name}". Run "flow add" first.`);
  return flow;
};

const requireFlowResource = (flows: FlowResource[], name: string): FlowResource => {
  const flow = flows.find((candidate) => candidate.name === name);
  if (flow === undefined) throw new CliError(`Unknown flow: "${name}". Run "flow add" first.`);
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
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
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
  const extensions =
    values.extensions !== undefined ? parseExtensions(values.extensions) : [...DEFAULT_EXTENSIONS];

  const announce = (library: { name: string; id: string; roots: string[] }): number => {
    console.log(
      `Added library "${library.name}" (${library.id}) with ${library.roots.length} root(s): ` +
        library.roots.join(', '),
    );
    return 0;
  };

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    requireNameAvailable({
      kind: 'library',
      existing:
        (await client.get<LibraryResource[]>('/libraries')).find(
          (library) => library.name === values.name,
        ) ?? null,
      name: values.name,
    });
    try {
      return announce(
        await client.post<LibraryResource>('/libraries', {
          name: values.name,
          roots: values.root,
          extensions,
          allowHardlinked: values['allow-hardlinked'],
        }),
      );
    } catch (error) {
      return asCliError(error, 'library add');
    }
  }

  const db = await openDb(values['data-dir']!);
  requireNameAvailable({
    kind: 'library',
    existing: createLibraryRepo(db).getByName(values.name),
    name: values.name,
  });

  return announce(
    createLibraryRepo(db).create({
      name: values.name,
      roots: values.root,
      extensions,
      allowHardlinked: values['allow-hardlinked'],
      nowMs: Date.now(),
    }),
  );
};

// ---------------------------------------------------------------------------
// flow add
// ---------------------------------------------------------------------------

/**
 * The plugin source name a template's community ids will be prefixed with:
 * whatever `--set pluginSource=` chose, else the template's own default.
 */
const templatePluginSource = (
  template: (typeof FLOW_TEMPLATES)[number],
  templateValues: Record<string, string>,
): string => {
  const given = templateValues.pluginSource;
  if (given !== undefined && given !== '') return given;
  return (
    template.parameters.find((parameter) => parameter.name === 'pluginSource')?.defaultValue ?? ''
  );
};

/**
 * Refuse a template whose community plugins are not installed, rather than
 * storing a flow that will fail per-file later.
 *
 * Flow validation treats a plugin it cannot resolve as UNKNOWN, not wrong —
 * deliberately, because a flow may name a plugin this host has not synced
 * yet. So a `conform-library` flow built before `plugin source sync` would
 * validate, store, attach to a library, and then fail three attempts per file
 * with an error naming the FILE. Naming the missing plugin here, before
 * anything is written, is the only place a user can act on it.
 */
const assertRequiredPluginsInstalled = (input: {
  template: (typeof FLOW_TEMPLATES)[number];
  templateValues: Record<string, string>;
  installedIds: readonly string[];
}): void => {
  const source = templatePluginSource(input.template, input.templateValues);
  const installed = new Set(input.installedIds);
  const missing = input.template.requiredPlugins
    .map((name) => (source === '' ? name : `${source}:${name}`))
    .filter((id) => !installed.has(id));
  if (missing.length === 0) return;
  throw new CliError(
    `flow add: template "${input.template.id}" needs plugin(s) ` +
      `${missing.map((id) => `"${id}"`).join(', ')} which are not installed. Add and sync a ` +
      `plugin source first:\n` +
      `  trawlarr plugin source add --name ${source} --url ` +
      `https://codeload.github.com/HaveAGitGat/Tdarr_Plugins/tar.gz/master\n` +
      `  trawlarr plugin source sync --name ${source}\n` +
      `Nothing was stored: a flow naming a plugin this host cannot resolve still validates, ` +
      `so it would have been accepted and then failed on every file.`,
  );
};

const cmdFlowAdd = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      name: { type: 'string' },
      file: { type: 'string' },
      template: { type: 'string' },
      set: { type: 'string', multiple: true },
    },
  });

  if (values.name === undefined) throw new CliError('flow add: --name is required.');
  if (values.file === undefined && values.template === undefined) {
    throw new CliError(
      `flow add: one of --file <flow.json> or --template <id> is required. The templates ` +
        `available are: ${FLOW_TEMPLATES.map((template) => template.id).join(', ')}.`,
    );
  }
  // Both, and the file would be silently ignored — which is the shape of a
  // command someone edits from one form to the other and half-finishes.
  if (values.file !== undefined && values.template !== undefined) {
    throw new CliError(
      `flow add: --file and --template are alternatives; pass one. --file loads a flow you ` +
        `wrote, --template builds one from a built-in.`,
    );
  }
  if (values.set !== undefined && values.template === undefined) {
    throw new CliError(`flow add: --set only means something with --template.`);
  }

  // `--set key=value`, split on the FIRST `=` only: a value may contain one
  // (an ffmpeg argument, a path), and a template parameter name never does.
  const templateValues: Record<string, string> = {};
  for (const entry of values.set ?? []) {
    const at = entry.indexOf('=');
    if (at <= 0) {
      throw new CliError(
        `flow add: --set "${entry}" is not "key=value". For example: --set encoder=hevc_nvenc.`,
      );
    }
    templateValues[entry.slice(0, at)] = entry.slice(at + 1);
  }

  // A parameter name the template does not have is a typo that would
  // otherwise be accepted in silence and produce the DEFAULT flow — which
  // validates, stores, runs, and does the wrong thing to a library.
  let chosenTemplate: (typeof FLOW_TEMPLATES)[number] | undefined;
  if (values.template !== undefined) {
    const template = FLOW_TEMPLATES.find((candidate) => candidate.id === values.template);
    if (template === undefined) {
      throw new CliError(
        `flow add: no flow template "${values.template}". Available: ` +
          `${FLOW_TEMPLATES.map((candidate) => candidate.id).join(', ')}.`,
      );
    }
    const known = new Set(template.parameters.map((parameter) => parameter.name));
    const unknown = Object.keys(templateValues).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new CliError(
        `flow add: template "${template.id}" has no parameter(s) ${unknown
          .map((key) => `"${key}"`)
          .join(', ')}. It takes: ${[...known].join(', ')}. Nothing was stored — a name with ` +
          `a typo in it would have been ignored and the template's default used instead.`,
      );
    }
    chosenTemplate = template;
  }

  const source =
    values.template === undefined ? `"${values.file!}"` : `template "${values.template}"`;

  let definition: FlowDefinition;
  if (values.template !== undefined) {
    definition = buildFromTemplate({ templateId: values.template, values: templateValues });
  } else {
    try {
      const text = await readFile(values.file!, 'utf8');
      definition = JSON.parse(text) as FlowDefinition;
    } catch (err) {
      throw new CliError(`flow add: could not read/parse "${values.file!}": ${messageOf(err)}`);
    }
  }

  const announce = (flow: { name: string; id: string; definition: FlowDefinition }): number => {
    console.log(`Added flow "${flow.name}" (${flow.id}), ${flow.definition.nodes.length} node(s).`);
    return 0;
  };

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    requireNameAvailable({
      kind: 'flow',
      existing:
        (await client.get<FlowResource[]>('/flows')).find((flow) => flow.name === values.name) ??
        null,
      name: values.name,
    });
    // The daemon owns the database, so the installed set is read through the
    // API it serves rather than by opening its file underneath it.
    if (chosenTemplate !== undefined && chosenTemplate.requiredPlugins.length > 0) {
      const plugins = await client.get<{ id: string }[]>('/plugins');
      assertRequiredPluginsInstalled({
        template: chosenTemplate,
        templateValues,
        installedIds: plugins.map((plugin) => plugin.id),
      });
    }
    try {
      // The daemon is the only writer, so the TEMPLATE travels rather than the
      // definition it produced: the flow stored is the one that daemon's own
      // template built, not one an older CLI on the host happened to render.
      const payload =
        values.template === undefined
          ? { name: values.name, definition }
          : { name: values.name, templateId: values.template, templateValues };
      return announce(await client.post<FlowResource>('/flows', payload));
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'unknown-template') {
        throw new CliError(`flow add: ${error.message}`);
      }
      if (error instanceof ApiRequestError && error.code === 'flow-invalid') {
        throw new CliError(
          `flow add: ${source} is not a flow trawlarr will run, so nothing was stored. ` +
            error.message,
        );
      }
      return asCliError(error, 'flow add');
    }
  }

  const db = await openDb(values['data-dir']!);
  requireNameAvailable({
    kind: 'flow',
    existing: createFlowRepo(db).getByName(values.name),
    name: values.name,
  });
  if (chosenTemplate !== undefined && chosenTemplate.requiredPlugins.length > 0) {
    assertRequiredPluginsInstalled({
      template: chosenTemplate,
      templateValues,
      installedIds: createPluginRepo(db)
        .listPlugins()
        .map((plugin) => plugin.id),
    });
  }

  // Validation lives in the repo (so nothing can write round it), but the
  // message a user sees belongs here: a FlowValidationError carries one
  // sentence per problem, and a flow file usually has more than one thing
  // wrong with it, so they are listed rather than joined into a paragraph.
  try {
    return announce(
      createFlowRepo(db).create({ name: values.name, definition, nowMs: Date.now() }),
    );
  } catch (err) {
    if (err instanceof FlowValidationError) {
      throw new CliError(
        `flow add: ${source} is not a flow trawlarr will run, so nothing was stored ` +
          `(${err.problems.length} problem(s)):\n` +
          err.problems.map((problem) => `  - ${problem.message}`).join('\n'),
      );
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// library set-flow
// ---------------------------------------------------------------------------

const cmdLibrarySetFlow = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      flow: { type: 'string' },
    },
  });

  if (values.library === undefined) throw new CliError('library set-flow: --library is required.');
  if (values.flow === undefined) throw new CliError('library set-flow: --flow is required.');

  const announce = (libraryName: string, flowName: string): number => {
    console.log(`Library "${libraryName}" now uses flow "${flowName}".`);
    return 0;
  };

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    const library = requireLibraryResource(
      await client.get<LibraryResource[]>('/libraries'),
      values.library,
    );
    const flow = requireFlowResource(await client.get<FlowResource[]>('/flows'), values.flow);
    try {
      await client.patch(`/libraries/${library.id}`, { flowId: flow.id });
    } catch (error) {
      return asCliError(error, 'library set-flow');
    }
    return announce(library.name, flow.name);
  }

  const db = await openDb(values['data-dir']!);
  const library = requireLibrary(db, values.library);
  const flow = requireFlow(db, values.flow);

  createLibraryRepo(db).setFlow(library.id, flow.id);
  return announce(library.name, flow.name);
};

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

const cmdScan = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      ffprobe: { type: 'string', default: 'ffprobe' },
      'allow-empty-roots': { type: 'boolean', default: false },
    },
  });

  if (values.library === undefined) throw new CliError('scan: --library is required.');

  const noFlow = (name: string): CliError =>
    new CliError(
      `Library "${name}" has no flow attached, so a scan cannot queue anything for it. ` +
        `Run "library set-flow --library ${name} --flow <name>" first.`,
    );

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    const library = requireLibraryResource(
      await client.get<LibraryResource[]>('/libraries'),
      values.library,
    );
    if (library.flowId === null) throw noFlow(library.name);
    try {
      await client.post(`/libraries/${library.id}/scan`);
    } catch (error) {
      return asCliError(error, 'scan');
    }
    // Deliberately NOT the summary the direct path prints, because there is
    // none to print: the daemon owns scanning, one walk per library at a
    // time, and it has queued this one rather than performed it. Pretending
    // otherwise would mean holding this command open for a walk that takes
    // minutes and reporting numbers that were never computed here.
    console.log(
      `Asked the trawlarr daemon (pid ${String(record.pid)}) to scan "${library.name}". The walk ` +
        `runs inside the daemon — it is the only process allowed to write this library, and it ` +
        `coalesces overlapping triggers into one scan — so this command does not wait for it. ` +
        `Watch it finish with "trawlarr status --library ${library.name}".`,
    );
    return 0;
  }

  const db = await openDb(values['data-dir']!);
  const library = requireLibrary(db, values.library);
  if (library.flowId === null) throw noFlow(library.name);

  const summary = await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: values.ffprobe!,
    nowMs: Date.now,
    // The same stored setting the daemon uses, so a scan run from the CLI
    // against a stopped daemon behaves the way the operator configured it.
    probeConcurrency: createSettingsRepo({ db }).getScan().probeConcurrency,
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
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      max: { type: 'string' },
      ffmpeg: { type: 'string', default: 'ffmpeg' },
      ffprobe: { type: 'string', default: 'ffprobe' },
    },
  });

  // The one command a daemon cannot be asked to perform on this process's
  // behalf: `run` IS a drain, and the daemon is already draining this queue
  // with a worker pool the schedule sizes. A second drain in this process
  // would claim from the same queue.
  const daemonRecord = await resolveDaemon(values['data-dir']!);
  if (daemonRecord !== null) {
    throw notWhileDaemonRuns(daemonRecord, {
      what: '"run" drains the queue itself, which it cannot do',
      instead:
        `The daemon is already draining it, as many files at a time as the schedule allows — ` +
        `watch it with "trawlarr status". To drain by hand instead, stop the daemon first. ` +
        `Nothing was claimed here.`,
    });
  }

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
        `find it with "trawlarr status --files", recover a specific one with ` +
        `"trawlarr requeue --file <id>", or let "trawlarr reap" reclaim every row whose ` +
        `worker has gone silent for a day.`,
    );
  }
  if (summary.pausedSkipped > 0) {
    console.log(
      `  ${summary.pausedSkipped} file(s) left untouched in paused libraries this drain.`,
    );
  }

  // The loudest thing `run` can say, because it means the drain stopped for a
  // reason that is not "there was nothing left to do" — and the alternative to
  // saying it is a command that never returns.
  if (summary.repeatClaimStop !== undefined) {
    const stop = summary.repeatClaimStop;
    console.log(
      `  STOPPED EARLY: "${stop.path}" was claimable again after ${stop.claims} run(s) in this ` +
        `drain that recorded no backoff (${stop.backoffs} of them held), so this drain would ` +
        `have kept re-running the same file indefinitely. Nothing else was claimed after it. ` +
        `That is a bug in trawlarr, not in your library — a file is only meant to become ` +
        `claimable again after a hold expires or after "trawlarr requeue". Look at that file ` +
        `with "trawlarr status --library <name> --files" and at its job history; the file id is ` +
        `${stop.fileId}. Run again to continue with the rest of the queue.`,
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
      renderSweep(await sweepTrashForLibrary({ db, library, nowMs: Date.now() }), { quiet: true });
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
 * Report one library's sweep.
 *
 * The sweep itself — including how the retention is resolved from the
 * library's own flow — lives in `library/trash-sweep.ts`, shared verbatim
 * with `POST /system/maintenance/trash-purge`, which is also where the
 * daemon-routed path of this command gets its summaries from. This function
 * is only the CLI's presentation of that value; a second copy of the
 * retention rule here is how the two would eventually disagree about when a
 * user's only remaining copy of a file may be deleted.
 */
const renderSweep = (sweep: LibraryTrashSweep, options?: { quiet?: boolean }): void => {
  const { summary } = sweep;
  if (options?.quiet === true && summary.removed === 0 && summary.failed === 0) return;

  const verb = sweep.dryRun ? 'would remove' : 'removed';
  console.log(
    `Trash for "${sweep.libraryName}" (retention ${sweep.retentionDays} day(s)): ${verb} ` +
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
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      days: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const days =
    values.days === undefined ? undefined : parseNonNegativeInt(values.days, 'trash purge: --days');

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    const libraryId =
      values.library === undefined
        ? undefined
        : requireLibraryResource(await client.get<LibraryResource[]>('/libraries'), values.library)
            .id;
    let sweeps: LibraryTrashSweep[];
    try {
      ({ sweeps } = await client.post<{ sweeps: LibraryTrashSweep[] }>(
        '/system/maintenance/trash-purge',
        { libraryId, days, dryRun: values['dry-run'] },
      ));
    } catch (error) {
      return asCliError(error, 'trash purge');
    }
    if (sweeps.length === 0) {
      console.log('No libraries configured.');
      return 0;
    }
    for (const sweep of sweeps) renderSweep(sweep);
    return 0;
  }

  const db = await openDb(values['data-dir']!);
  const libraries =
    values.library !== undefined
      ? [requireLibrary(db, values.library)]
      : createLibraryRepo(db).list();
  if (libraries.length === 0) {
    console.log('No libraries configured.');
    return 0;
  }

  for (const library of libraries) {
    renderSweep(
      await sweepTrashForLibrary({
        db,
        library,
        days,
        nowMs: Date.now(),
        dryRun: values['dry-run'],
      }),
    );
  }
  return 0;
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * One library as `status` prints it, gathered identically whether it came
 * from the database or from a running daemon's API.
 *
 * The point of the shape is that there is exactly ONE renderer: a `status`
 * that printed differently depending on whether a daemon happened to be
 * running is a bug report waiting to be filed, and the difference would be
 * invisible to whoever introduced it.
 */
interface StatusLibrary {
  name: string;
  roots: string[];
  extensions: string[];
  counts: Record<FileState, number>;
  missing: number;
  /**
   * Why this library is not converging, or null when it is not paused.
   * Produced by `explainPause` on both paths — directly here, and inside the
   * daemon for the API path — never re-derived, because a second explanation
   * would drift from the API's the first time either was edited.
   */
  pausedExplanation: string | null;
  files: {
    id: string;
    state: FileState;
    attemptCount: number;
    path: string;
    gone: number | null;
  }[];
}

const cmdStatus = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      files: { type: 'boolean', default: false },
      state: { type: 'string' },
      missing: { type: 'boolean', default: false },
    },
  });

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

  const record = await resolveDaemon(values['data-dir']!);
  const libraries: StatusLibrary[] = [];

  if (record !== null) {
    const client = createCliClient(record);
    const all = await client.get<LibraryResource[]>('/libraries');
    const wanted =
      values.library !== undefined ? [requireLibraryResource(all, values.library)] : all;
    for (const library of wanted) {
      const stats = await client.get<StatsResource>(`/libraries/${library.id}/stats`);
      const files = showFiles
        ? await fetchAllFiles(client, {
            libraryId: library.id,
            state: stateFilter,
            missing: values.missing ? true : undefined,
          })
        : [];
      libraries.push({
        name: library.name,
        roots: library.roots,
        extensions: library.extensions,
        counts: stats.byState,
        missing: stats.missing,
        pausedExplanation: library.pausedExplanation,
        files: files.map((file) => ({
          id: file.id,
          state: file.state,
          attemptCount: file.attemptCount,
          path: file.path,
          gone: file.missingSinceMs,
        })),
      });
    }
  } else {
    const db = await openDb(values['data-dir']!);
    const libraryRepo = createLibraryRepo(db);
    const mediaFileRepo = createMediaFileRepo(db);
    const wanted =
      values.library !== undefined ? [requireLibrary(db, values.library)] : libraryRepo.list();
    for (const library of wanted) {
      const rows = !showFiles
        ? []
        : values.missing
          ? mediaFileRepo.listMissing(library.id)
          : mediaFileRepo.listByLibrary({ libraryId: library.id, state: stateFilter });
      libraries.push({
        name: library.name,
        roots: library.roots,
        extensions: library.extensions,
        counts: mediaFileRepo.countsByState(library.id),
        missing: mediaFileRepo.missingCount(library.id),
        pausedExplanation: explainPause(library)?.explanation ?? null,
        files: rows.map((row) => ({
          id: row.id,
          state: row.state,
          attemptCount: row.attempt_count,
          path: row.path,
          gone: row.missing_since_ms,
        })),
      });
    }
  }

  if (libraries.length === 0) {
    console.log('No libraries configured.');
    return 0;
  }

  for (const library of libraries) {
    const counts = library.counts;
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    // Deliberately outside `total`: `countsByState` already excludes these,
    // and a file that no longer exists can never reach `good`, so counting
    // it would cap the percentage below 100% forever for a file the user
    // deleted on purpose. Reported on its own line instead of hidden.
    const missing = library.missing;

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
      renderPause(library);
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

    renderPause(library);

    if (missing > 0) {
      console.log(
        `  ${missing} file(s) are gone from disk. Their rows (and job history) are kept and ` +
          `excluded from the count above; putting a file back makes the next scan pick it up ` +
          `exactly where it left off. List them with "trawlarr status --library ` +
          `${library.name} --missing", or discard them for good with "trawlarr forget ` +
          `--missing --library ${library.name}".`,
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
      const rows = [...library.files].sort((a, b) => a.path.localeCompare(b.path));
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
        const gone = row.gone === null ? '' : `  MISSING since ${new Date(row.gone).toISOString()}`;
        console.log(
          `  ${row.id}  ${row.state.padEnd(15)} attempts ${row.attemptCount}  ${row.path}${gone}`,
        );
      }
    }
  }
  return 0;
};

/**
 * THE LINE THAT WAS MISSING.
 *
 * `library.paused_reason` has been written since the flow-health check
 * existed, and the API has reported it since the API existed — but `status`,
 * the one command an operator actually runs, did not. A paused library is
 * indistinguishable from a converged one from the outside: no jobs, no
 * errors, no output, and a percentage that simply stops moving. So the
 * explanation is printed HERE, in full, and it is `explainPause`'s — the same
 * text `GET /api/v1/libraries` returns, never a second wording that could
 * drift from it.
 */
const renderPause = (library: StatusLibrary): void => {
  if (library.pausedExplanation === null) return;
  console.log(`  PAUSED: ${library.pausedExplanation}`);
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
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
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

  const unknownFile = (id: string): CliError =>
    new CliError(`requeue: no file with id "${id}". Ids come from "trawlarr status --files".`);

  /** What each requeued row looked like BEFORE it was requeued. */
  let targets: { path: string; state: string; gone: number | null; requeue: () => Promise<void> }[];

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    if (byFile) {
      targets = [];
      for (const id of values.file!) {
        let file: FileResource;
        try {
          ({ file } = await client.get<{ file: FileResource }>(`/files/${id}`));
        } catch (error) {
          if (error instanceof ApiRequestError && error.status === 404) throw unknownFile(id);
          throw error;
        }
        targets.push({
          path: file.path,
          state: file.state,
          gone: file.missingSinceMs,
          requeue: async () => {
            await client.post(`/files/${file.id}/requeue`);
          },
        });
      }
    } else {
      const library = requireLibraryResource(
        await client.get<LibraryResource[]>('/libraries'),
        values.library!,
      );
      const files = await fetchAllFiles(client, {
        libraryId: library.id,
        state: parseState(values.state!, 'requeue: --state'),
      });
      targets = files.map((file) => ({
        path: file.path,
        state: file.state,
        gone: file.missingSinceMs,
        requeue: async () => {
          await client.post(`/files/${file.id}/requeue`);
        },
      }));
    }
  } else {
    const db = await openDb(values['data-dir']!);
    const mediaFileRepo = createMediaFileRepo(db);
    const rows = byFile
      ? values.file!.map((id) => {
          const row = mediaFileRepo.getById(id);
          if (row === null) throw unknownFile(id);
          return row;
        })
      : mediaFileRepo.listByLibrary({
          libraryId: requireLibrary(db, values.library!).id,
          state: parseState(values.state!, 'requeue: --state'),
        });
    targets = rows.map((row) => ({
      path: row.path,
      state: row.state,
      gone: row.missing_since_ms,
      requeue: async () => {
        mediaFileRepo.requeue(row.id);
      },
    }));
  }

  if (targets.length === 0) {
    console.log(`No files in state "${values.state!}" in library "${values.library!}".`);
    return 0;
  }

  for (const target of targets) {
    await target.requeue();
    // Requeueing a row whose file is gone is legal (the ledger state really
    // does go back to `queued`) but does nothing until the file returns,
    // since `claimNext` skips missing rows. Saying so beats a user watching
    // "trawlarr run" claim nothing and finding no explanation anywhere.
    const gone =
      target.gone === null
        ? ''
        : '  (file is gone from disk; it will not be claimed until it comes back)';
    console.log(`  ${target.path}: ${target.state} -> queued${gone}`);
  }
  console.log(
    `Requeued ${targets.length} file(s). Run "trawlarr run" to work through them ` +
      `(a requeued file is claimed immediately: its attempt count and backoff are cleared).`,
  );
  return 0;
};

// ---------------------------------------------------------------------------
// reap
// ---------------------------------------------------------------------------

/**
 * The recovery for a row stranded in `running` by a worker that was killed
 * mid-transcode. Nothing else reaches one: `claimNext` takes only
 * `queued`/`held`, the scanner refuses to touch `running`, and `runJob`'s
 * own stall handler cannot run in a process that no longer exists.
 */
const cmdReap = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      'stale-after-hours': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const hours =
    values['stale-after-hours'] === undefined
      ? undefined
      : parseNonNegativeInt(values['stale-after-hours'], 'reap: --stale-after-hours');

  let summary: ReapSummary;

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    const libraryId =
      values.library === undefined
        ? undefined
        : requireLibraryResource(await client.get<LibraryResource[]>('/libraries'), values.library)
            .id;
    try {
      summary = await client.post<ReapSummary>('/system/maintenance/reap', {
        libraryId,
        staleAfterHours: hours,
        dryRun: values['dry-run'],
      });
    } catch (error) {
      return asCliError(error, 'reap');
    }
  } else {
    const db = await openDb(values['data-dir']!);
    const libraryIds =
      values.library === undefined ? undefined : [requireLibrary(db, values.library).id];
    summary = reapStalled({
      db,
      nowMs: Date.now(),
      staleAfterMs: hours === undefined ? undefined : hours * 60 * 60 * 1000,
      libraryIds,
      dryRun: values['dry-run'],
    });
  }

  const staleAfterHours = hours ?? DEFAULT_STALE_AFTER_MS / (60 * 60 * 1000);
  if (summary.running === 0) {
    console.log('No files are running, so there is nothing to reclaim.');
    return 0;
  }

  for (const file of summary.files) {
    console.log(
      `  ${file.fileId}  running -> ${file.state}  ${file.path} ` +
        `(last sign of life ${new Date(file.lastActivityMs).toISOString()})`,
    );
  }
  console.log(
    `${summary.running} file(s) running: ${summary.reclaimed} ` +
      `${values['dry-run'] ? 'would be reclaimed' : 'reclaimed'} after ${staleAfterHours} ` +
      `hour(s) without a heartbeat, ${summary.live} still alive and left running. ` +
      `A reclaimed file counts as a failed attempt, so it backs off and becomes "failed" ` +
      `once its attempts are exhausted — it is not silently retried for ever.`,
  );
  return 0;
};

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

interface ForgetResult {
  libraryName: string;
  summary: ForgetSummary;
}

/**
 * Discard rows whose file is gone for good. The counterpart to the scanner's
 * deliberate decision to MARK rather than delete: a media library churns —
 * files are replaced by better rips constantly — so without this, dead rows
 * accumulate for ever, merely labelled instead of miscounted.
 *
 * Explicit by design, and never something a scan does on its own: nothing
 * that runs unattended should be able to destroy a record.
 */
const cmdForget = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      library: { type: 'string' },
      missing: { type: 'boolean', default: false },
      file: { type: 'string', multiple: true },
      'include-terminal': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const byFile = values.file !== undefined && values.file.length > 0;
  if (!byFile && !values.missing) {
    throw new CliError(
      'forget: name what to forget — either "--missing" (every row whose file this library ' +
        'has confirmed gone; add --library to scope it) or "--file <id>" (repeatable, ids ' +
        'come from "trawlarr status --missing").',
    );
  }
  if (byFile && values.missing) {
    throw new CliError('forget: use either --file or --missing, not both.');
  }

  let results: ForgetResult[];

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    const client = createCliClient(record);
    const libraryId =
      values.library === undefined
        ? undefined
        : requireLibraryResource(await client.get<LibraryResource[]>('/libraries'), values.library)
            .id;
    try {
      ({ results } = await client.post<{ results: ForgetResult[] }>('/system/maintenance/forget', {
        libraryId,
        fileIds: byFile ? values.file : undefined,
        missing: values.missing ? true : undefined,
        includeTerminal: values['include-terminal'],
        dryRun: values['dry-run'],
      }));
    } catch (error) {
      return asCliError(error, 'forget');
    }
  } else {
    const db = await openDb(values['data-dir']!);
    const libraries =
      values.library !== undefined
        ? [requireLibrary(db, values.library)]
        : createLibraryRepo(db).list();
    results = [];
    for (const library of libraries) {
      results.push({
        libraryName: library.name,
        summary: await forgetMissing({
          db,
          library,
          fileIds: byFile ? values.file : undefined,
          includeTerminal: values['include-terminal'],
          dryRun: values['dry-run'],
        }),
      });
    }
  }

  let forgotten = 0;
  for (const result of results) {
    const summary = result.summary;
    for (const file of summary.files) {
      console.log(
        `  ${values['dry-run'] ? 'would forget' : 'forgot'} ${file.fileId}  ${file.state}  ` +
          `${file.path}  (discarding ${file.jobCount} job record(s) and their step traces)`,
      );
    }
    forgotten += summary.forgotten;

    if (summary.restored > 0) {
      console.log(
        `  ${summary.restored} row(s) in "${result.libraryName}" turned out to have their file ` +
          `back after all; their missing mark was cleared instead of being forgotten.`,
      );
    }
    if (summary.unconfirmed > 0) {
      console.log(
        `  ${summary.unconfirmed} row(s) in "${result.libraryName}" left alone: their path could ` +
          `not be examined just now, and "I could not check" is not "it is gone".`,
      );
    }
    if (summary.keptTerminal > 0) {
      console.log(
        `  ${summary.keptTerminal} missing row(s) in "${result.libraryName}" are in a terminal ` +
          `state (failed / not_converging) and were KEPT: their attempt history is the only ` +
          `record of why trawlarr gave up on that file. Add --include-terminal, or name them ` +
          `with --file <id>, to forget those too.`,
      );
    }
    if (summary.notMissing > 0) {
      console.log(
        `  ${summary.notMissing} named row(s) are not marked missing and were left alone: only ` +
          `a scan that confirmed the file gone can authorise forgetting it.`,
      );
    }
  }

  console.log(
    values['dry-run']
      ? `${forgotten} row(s) would be forgotten. Nothing was changed.`
      : `Forgot ${forgotten} row(s). Their ledger entries and job history are gone for good; ` +
          `the files themselves were already gone.`,
  );
  return 0;
};

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

/**
 * Run trawlarr as a service, in the foreground.
 *
 * Foreground on purpose: this is what an init system, a container, or a
 * terminal supervises, and a process that daemonises itself is one systemd
 * and Docker both have to be told to work around. Ctrl-C (SIGINT) and
 * `systemctl stop` (SIGTERM) both reach `stop()`, which drains rather than
 * killing — see `daemon.ts` for why the drain has a deadline.
 */
const cmdDaemon = async (args: string[]): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
      port: { type: 'string' },
      bind: { type: 'string' },
    },
  });

  const portRaw = values.port ?? process.env.TRAWLARR_PORT;
  const port = portRaw === undefined ? undefined : parseNonNegativeInt(portRaw, 'daemon: --port');
  const bind = values.bind ?? process.env.TRAWLARR_BIND;

  let daemon;
  try {
    daemon = await startDaemon({ dataDir: values['data-dir']!, port, bind });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) throw new CliError(error.message);
    throw error;
  }

  console.log(
    `trawlarr daemon listening on http://${daemon.bind}:${String(daemon.port)}/api/v1 ` +
      `(data directory ${resolve(values['data-dir']!)}).`,
  );
  if (daemon.apiKeyGenerated) {
    // Printed exactly once, on the run that minted it. It is stored in the
    // database from now on (setting "daemon.apiKey", also readable at
    // GET /system/settings), so a later start printing it again would be
    // spraying a live credential into every log that captures stdout.
    console.log(`  API key (generated on this first run, stored from now on): ${daemon.apiKey}`);
  }
  console.log(
    `  The API binds ${daemon.bind} by default and speaks plain HTTP: put a reverse proxy in ` +
      `front of it if it needs to be reachable from anywhere else. While this daemon is running ` +
      `it owns the data directory, and "trawlarr" commands in other terminals talk to it rather ` +
      `than opening the database. Stop it with Ctrl-C: work already in progress is drained, not ` +
      `killed.`,
  );

  await daemon.stopped;
  console.log('trawlarr daemon stopped.');
  return 0;
};

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/** A plugin as `GET /plugins` reports it, and as the direct path renders it. */
interface PluginResource {
  id: string;
  name: string;
  description?: string;
  version: string;
  source: 'first-party' | 'installed' | 'path';
  sourceId?: string | null;
  absPath?: string;
  details: PluginDetails;
}

/**
 * A plugin source as `GET /plugins/sources` reports it — the row, what it has
 * installed, and where its last sync got to.
 *
 * The commands below render THIS shape whether they read it from the daemon
 * or built it from the local database, so the two paths cannot drift into
 * printing different things about the same source.
 */
interface PluginSourceResource {
  id: string;
  url: string;
  kind: 'tarball' | 'local';
  enabled: boolean;
  lastSyncedAtMs: number | null;
  installedCount: number;
  sync: {
    runId: number | null;
    running: boolean;
    report: { installed: number; skipped: { relPath: string; reason: string }[] } | null;
    error: { code: string; message: string } | null;
  };
}

/** How often a `plugin source sync` against a live daemon asks whether its run has finished. */
const SYNC_POLL_INTERVAL_MS = 500;

/**
 * How long that polling goes on before it calls itself a hang.
 *
 * Generous on purpose — a first sync of Tdarr's repository fetches and
 * validates ninety-one plugins — and it is not a performance expectation:
 * its only job is to turn a daemon that has silently stopped answering into
 * a sentence saying what was being waited for.
 */
const SYNC_WAIT_DEADLINE_MS = 60 * 60 * 1000;

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
};

/**
 * Wait for the run this invocation started, and nothing else.
 *
 * `POST /plugins/sources/:id/sync` answers 202 — the daemon does the work,
 * because it is the only process allowed to write — so the result has to be
 * read back afterwards. Matching on the RUN ID rather than on "is it running"
 * is what makes that correct: a sync that finished before the first poll and
 * a sync that has not started yet both read as "not running", and without the
 * id this would report the previous run's outcome for the new one.
 */
const awaitSyncRun = async (
  client: CliClient,
  sourceId: string,
  runId: number,
  nowMs: () => number = () => Date.now(),
): Promise<PluginSourceResource['sync']> => {
  const deadline = nowMs() + SYNC_WAIT_DEADLINE_MS;
  for (;;) {
    const source = await client.get<PluginSourceResource>(
      `/plugins/sources/${encodeURIComponent(sourceId)}`,
    );
    if (source.sync.runId === runId && !source.sync.running) return source.sync;
    if (nowMs() > deadline) {
      throw new CliError(
        `plugin source sync: the daemon accepted the sync of "${sourceId}" (run ` +
          `${String(runId)}) but has not reported it finished. Ask it directly with ` +
          `GET /api/v1/plugins/sources/${sourceId}.`,
      );
    }
    await delay(SYNC_POLL_INTERVAL_MS);
  }
};

/** The one `--data-dir` option every plugin command shares. */
const dataDirOption = {
  'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
} as const;

const openPluginRepo = async (dataDir: string) => createPluginRepo(await openDb(dataDir));

/** The same "which sources are there, then" answer wherever a name misses. */
const unknownPluginSource = (label: string, repo: PluginRepo, name: string): CliError =>
  new CliError(
    `${label}: no plugin source "${name}". Known sources: ` +
      `${repo.listSources().map((source) => source.id).join(', ') || '(none)'}.`, // prettier-ignore
  );

/** `a ?? throwCli(e)` — an expression, so a fallback can still be a refusal. */
const throwCli = (error: CliError): never => {
  throw error;
};

/** Domain errors from the plugin layer, as this command's own diagnosable failure. */
const asPluginCliError = <T>(label: string, run: () => T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof PluginIdError || error instanceof PluginRepoError) {
      throw new CliError(`${label}: ${error.message}`);
    }
    throw error;
  }
};

const cmdPluginSourceAdd = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      url: { type: 'string' },
      path: { type: 'string' },
      ...dataDirOption,
    },
  });

  if (values.name === undefined) throw new CliError('plugin source add: --name is required.');

  const hasUrl = values.url !== undefined && values.url !== '';
  const hasPath = values.path !== undefined && values.path !== '';
  if (hasUrl === hasPath) {
    // Both, or neither. Refused rather than resolved by precedence: an
    // ignored flag silently gives the user the OTHER one's behaviour, which
    // is a source pointing somewhere they did not ask for.
    throw new CliError(
      `plugin source add: exactly one of --url (an https .tar.gz, for example ` +
        `https://codeload.github.com/HaveAGitGat/Tdarr_Plugins/tar.gz/master) or --path (a ` +
        `directory already on this machine) is required.`,
    );
  }

  // Before anything is created on disk: a reserved or malformed name is a
  // typo, and answering it should not leave a data directory behind.
  asPluginCliError('plugin source add', () => {
    assertValidSourceSlug(values.name!);
  });

  if (hasUrl && !values.url!.startsWith('https://')) {
    throw new CliError(
      `plugin source add: --url must be an https URL, got "${values.url!}". Plugin code is ` +
        `executed by this service, so it is only ever fetched over a connection that cannot be ` +
        `rewritten in transit. Use --path for a directory already on this machine.`,
    );
  }
  if (hasPath && !existsSync(values.path!)) {
    throw new CliError(
      `plugin source add: --path "${values.path!}" does not exist on this machine. A source ` +
        `pointing at nothing would be added happily and then install nothing at every sync.`,
    );
  }

  // There is exactly one sensible kind per flag, so the user never types one.
  const kind = hasUrl ? ('tarball' as const) : ('local' as const);
  const url = hasUrl ? values.url! : resolve(values.path!);

  const record = await resolveDaemon(values['data-dir']!);
  let source: { id: string; kind: string; url: string };
  if (record !== null) {
    // The daemon owns the database, so IT writes the row — the same rule
    // `library add` and `flow add` follow. Nothing here opens the file.
    try {
      source = await createCliClient(record).post<PluginSourceResource>('/plugins/sources', {
        id: values.name!,
        ...(hasUrl ? { url } : { path: url }),
      });
    } catch (error) {
      return asCliError(error, 'plugin source add');
    }
  } else {
    const repo = await openPluginRepo(values['data-dir']!);
    source = asPluginCliError('plugin source add', () =>
      repo.addSource({ id: values.name!, url, kind }),
    );
  }

  console.log(
    `Added plugin source "${source.id}" (${source.kind}): ${source.url}. Nothing is installed ` +
      `yet — run "trawlarr plugin source sync --name ${source.id}" to install its plugins.`,
  );
  console.log(`  ${PLUGIN_TRUST_CONSEQUENCE}`);
  return 0;
};

const cmdPluginSourceList = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({ args: argv, options: { ...dataDirOption } });

  const record = await resolveDaemon(values['data-dir']!);
  let sources: PluginSourceResource[];
  if (record !== null) {
    try {
      sources = await createCliClient(record).get<PluginSourceResource[]>('/plugins/sources');
    } catch (error) {
      return asCliError(error, 'plugin source list');
    }
  } else {
    const repo = await openPluginRepo(values['data-dir']!);
    sources = repo.listSources().map((source) => ({
      ...source,
      installedCount: repo.listPlugins(source.id).length,
      // No daemon means no sync has ever run in this process; the row's
      // `lastSyncedAtMs` is what says whether one ever ran at all.
      sync: { runId: null, running: false, report: null, error: null },
    }));
  }
  if (sources.length === 0) {
    console.log(
      'No plugin sources. Add one with "trawlarr plugin source add --name <name> --url ' +
        '<https tarball>" or "--path <directory>"; trawlarr\'s own plugins need no source and ' +
        'are always available.',
    );
    return 0;
  }

  for (const source of sources) {
    const installed = source.installedCount;
    // "never" rather than a blank column: a source that has never synced is
    // the reason its plugins are missing, and that is the answer.
    const synced =
      source.lastSyncedAtMs === null
        ? 'never synced'
        : `last synced ${new Date(source.lastSyncedAtMs).toISOString()}`;
    console.log(
      `${source.id}  (${source.kind}${source.enabled ? '' : ', disabled'})  ${source.url}  ` +
        `${synced}  ${String(installed)} plugin(s) installed`,
    );
  }
  return 0;
};

const cmdPluginSourceRemove = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({ args: argv, options: { name: { type: 'string' }, ...dataDirOption } }); // prettier-ignore

  if (values.name === undefined) throw new CliError('plugin source remove: --name is required.');

  const record = await resolveDaemon(values['data-dir']!);
  let sourceId: string;
  let pluginIds: string[];
  if (record !== null) {
    const client = createCliClient(record);
    try {
      // Read the plugins BEFORE the delete: the cascade takes them with the
      // source, and the sentence below names one of them.
      const source = await client.get<PluginSourceResource>(
        `/plugins/sources/${encodeURIComponent(values.name)}`,
      );
      pluginIds = (await client.get<PluginResource[]>('/plugins'))
        .filter((plugin) => plugin.sourceId === source.id)
        .map((plugin) => plugin.id);
      await client.delete(`/plugins/sources/${encodeURIComponent(source.id)}`);
      sourceId = source.id;
    } catch (error) {
      return asCliError(error, 'plugin source remove');
    }
  } else {
    const repo = await openPluginRepo(values['data-dir']!);
    const source = repo.getSource(values.name);
    if (source === null) throw unknownPluginSource('plugin source remove', repo, values.name);
    pluginIds = repo.listPlugins(source.id).map((plugin) => plugin.id);
    repo.removeSource(source.id);
    sourceId = source.id;
  }

  console.log(
    `Removed plugin source "${sourceId}" and the ${String(pluginIds.length)} plugin(s) it ` +
      `installed.`,
  );
  if (pluginIds.length > 0) {
    console.log(
      `  A flow that still names one of them (for example ${pluginIds[0]!}) now names a plugin ` +
        `this host cannot resolve: the API answers 404 for it, and every library whose flow uses ` +
        `it pauses naming that id — exactly as it would have if the plugin had never been ` +
        `installed. Adding the source back and syncing it clears the pause on its own.`,
    );
  }
  return 0;
};

const cmdPluginSourceSync = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: 'string' }, all: { type: 'boolean', default: false }, ...dataDirOption }, // prettier-ignore
  });
  if (values.name === undefined && values.all !== true) {
    throw new CliError('plugin source sync: --name <source> or --all is required.');
  }

  const printReport = (
    target: { id: string; kind: string },
    report: { installed: number; skipped: { relPath: string; reason: string }[] },
  ): void => {
    console.log(
      `Synced "${target.id}" (${target.kind}): ${String(report.installed)} plugin(s) installed, ` +
        `${String(report.skipped.length)} skipped.`,
    );
    for (const skip of report.skipped) {
      // Printed individually: a source where half the plugins failed to load
      // must not look like a source where they never existed.
      console.log(`  skipped ${skip.relPath}: ${skip.reason}`);
    }
  };

  const record = await resolveDaemon(values['data-dir']!);

  if (record !== null) {
    // The daemon does the syncing — it is the only writer, and it is the
    // process whose plugin directory the extraction lands in. This asks, then
    // waits for the run it started: `POST .../sync` answers 202 because a
    // sync of a real repository takes minutes.
    const client = createCliClient(record);
    let targets: PluginSourceResource[];
    try {
      targets =
        values.all === true
          ? (await client.get<PluginSourceResource[]>('/plugins/sources')).filter(
              (source) => source.enabled,
            )
          : [
              await client.get<PluginSourceResource>(
                `/plugins/sources/${encodeURIComponent(values.name!)}`,
              ),
            ];
    } catch (error) {
      return asCliError(error, 'plugin source sync');
    }

    if (targets.length === 0) {
      console.log('No enabled plugin sources to sync. Add one with "trawlarr plugin source add".');
      return 0;
    }

    console.log(PLUGIN_TRUST_CONSEQUENCE);
    for (const target of targets) {
      let outcome: PluginSourceResource['sync'];
      try {
        const started = await client.post<{ runId: number }>(
          `/plugins/sources/${encodeURIComponent(target.id)}/sync`,
        );
        outcome = await awaitSyncRun(client, target.id, started.runId);
      } catch (error) {
        return asCliError(error, 'plugin source sync');
      }
      if (outcome.error !== null) {
        // The daemon's own wording, verbatim: it was composed for this
        // reader, and a second one here would drift from it.
        throw new CliError(
          `plugin source sync: "${target.id}" failed (${outcome.error.code}): ` +
            `${outcome.error.message}`,
        );
      }
      printReport(target, outcome.report ?? { installed: 0, skipped: [] });
    }
    return 0;
  }

  const dataDir = resolve(values['data-dir']!);
  const repo = await openPluginRepo(dataDir);

  const targets =
    values.all === true
      ? repo.listSources().filter((source) => source.enabled)
      : [repo.getSource(values.name!) ?? throwCli(unknownPluginSource('plugin source sync', repo, values.name!))]; // prettier-ignore

  if (targets.length === 0) {
    console.log('No enabled plugin sources to sync. Add one with "trawlarr plugin source add".');
    return 0;
  }

  console.log(PLUGIN_TRUST_CONSEQUENCE);
  for (const target of targets) {
    printReport(
      target,
      await syncSource({
        repo,
        sourceId: target.id,
        // A tarball source's extracted tree IS the installed plugin, so it lives
        // permanently under the data directory, not in a temp dir a reboot clears.
        cacheDir: join(dataDir, 'plugins'),
        nowMs: () => Date.now(),
      }),
    );
  }
  return 0;
};

// ---------------------------------------------------------------------------
// plugin list / show
// ---------------------------------------------------------------------------

const firstPartyResources = (): PluginResource[] =>
  Object.values(FIRST_PARTY_PLUGINS).map((entry) => {
    const details = entry.module.details();
    return {
      id: entry.id,
      name: details.name,
      description: details.description,
      version: '1.0.0',
      source: 'first-party' as const,
      details,
    };
  });

const installedResources = (repo: PluginRepo, sourceId?: string): PluginResource[] =>
  repo.listPlugins(sourceId).map((row) => ({
    id: row.id,
    name: row.details.name,
    description: row.details.description,
    version: row.version,
    source: 'installed' as const,
    sourceId: row.sourceId,
    absPath: row.absPath,
    details: row.details,
  }));

const renderPluginRow = (plugin: PluginResource): void => {
  const origin =
    plugin.source === 'first-party'
      ? 'first-party'
      : plugin.source === 'path'
        ? 'path'
        : `from source "${plugin.sourceId ?? '?'}"`;
  console.log(`  ${plugin.id.padEnd(40)} ${plugin.name}  (${origin})`);
};

const cmdPluginList = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { source: { type: 'string' }, ...dataDirOption },
  });

  let firstParty: PluginResource[];
  let installed: PluginResource[];

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    // Reading plugins IS served by the daemon, so this command works while
    // one runs — unlike the source commands above.
    let all: PluginResource[];
    try {
      all = await createCliClient(record).get<PluginResource[]>('/plugins');
    } catch (error) {
      return asCliError(error, 'plugin list');
    }
    firstParty = all.filter((plugin) => plugin.source === 'first-party');
    installed = all.filter(
      (plugin) =>
        plugin.source === 'installed' &&
        (values.source === undefined || plugin.sourceId === values.source),
    );
    if (values.source !== undefined && installed.length === 0) {
      const known = [
        ...new Set(
          all
            .filter((plugin) => plugin.source === 'installed')
            .map((plugin) => plugin.sourceId ?? '?'),
        ),
      ];
      throw new CliError(
        `plugin list: no plugins installed from source "${values.source}". Sources with ` +
          `installed plugins: ${known.join(', ') || '(none)'}.`,
      );
    }
  } else {
    const repo = await openPluginRepo(values['data-dir']!);
    if (values.source !== undefined && repo.getSource(values.source) === null) {
      throw unknownPluginSource('plugin list', repo, values.source);
    }
    firstParty = values.source === undefined ? firstPartyResources() : [];
    installed = installedResources(repo, values.source);
  }

  if (firstParty.length > 0) {
    console.log("trawlarr's own plugins:");
    for (const plugin of firstParty) renderPluginRow(plugin);
  }
  if (installed.length > 0) {
    console.log('Installed from a plugin source:');
    for (const plugin of installed) renderPluginRow(plugin);
  } else if (values.source === undefined) {
    console.log(
      'No plugins installed from a source yet. "trawlarr plugin source add" then ' +
        '"trawlarr plugin source sync" installs some.',
    );
  }
  console.log(
    `${String(firstParty.length)} first-party, ${String(installed.length)} installed. ` +
      `Name one in a flow node by its id.`,
  );
  return 0;
};

/** A tooltip is free-form and often a paragraph; one line is what a list can show. */
const firstLine = (text: string | undefined): string =>
  (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';

const renderPluginDetails = (plugin: PluginResource): void => {
  const details = plugin.details;
  console.log(`${plugin.id}  —  ${plugin.name}  (version ${plugin.version})`);
  console.log(
    plugin.source === 'installed'
      ? `  installed from source "${plugin.sourceId ?? '?'}"${plugin.absPath === undefined ? '' : `: ${plugin.absPath}`}` // prettier-ignore
      : plugin.source === 'path'
        ? `  loaded by path: ${plugin.absPath ?? plugin.id}`
        : "  one of trawlarr's own plugins",
  );
  if (firstLine(details.description) !== '') console.log(`  ${firstLine(details.description)}`);

  const inputs = Array.isArray(details.inputs) ? details.inputs : [];
  console.log(`  Inputs (${String(inputs.length)}):`);
  for (const input of inputs) {
    // The default is shown because a flow that omits an input gets it, and
    // "what happens if I leave this alone" is the question this answers.
    console.log(
      `    ${input.name}  (${input.type}, default ${JSON.stringify(input.defaultValue)})` +
        `${input.label === input.name || input.label === '' ? '' : ` — ${input.label}`}`,
    );
    if (firstLine(input.tooltip) !== '') console.log(`      ${firstLine(input.tooltip)}`);
  }

  const outputs = Array.isArray(details.outputs) ? details.outputs : [];
  console.log(`  Outputs (${String(outputs.length)}):`);
  for (const output of outputs) {
    // The output NUMBER is what an edge names, so it leads the line.
    console.log(
      `    ${String(output.number)}  ${firstLine(output.tooltip)}` +
        `${output.outcome === undefined ? '' : `  [${output.outcome}]`}`,
    );
  }
};

const cmdPluginShow = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { id: { type: 'string' }, ...dataDirOption },
  });
  if (values.id === undefined) {
    throw new CliError(
      'plugin show: --id is required. Ids come from "trawlarr plugin list" — for example ' +
        '"trawlarr:execute" or "tdarr:ffmpegCommandSetContainer".',
    );
  }
  const id = values.id;

  const notFound = (): CliError =>
    new CliError(
      `plugin show: no plugin "${id}" is installed here, and it is not a path this host can ` +
        `load. First-party ids look like "trawlarr:execute"; an installed one looks like ` +
        `"tdarr:ffmpegCommandSetContainer" and needs its source added and synced; a community ` +
        `plugin with no source is named by its absolute path.`,
    );

  const record = await resolveDaemon(values['data-dir']!);
  if (record !== null) {
    try {
      renderPluginDetails(
        await createCliClient(record).get<PluginResource>(`/plugins/${encodeURIComponent(id)}`),
      );
      return 0;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) throw notFound();
      return asCliError(error, 'plugin show');
    }
  }

  const firstParty = firstPartyResources().find((plugin) => plugin.id === id);
  if (firstParty !== undefined) {
    renderPluginDetails(firstParty);
    return 0;
  }

  const repo = await openPluginRepo(values['data-dir']!);
  const installed = installedResources(repo).find((plugin) => plugin.id === id);
  if (installed !== undefined) {
    renderPluginDetails(installed);
    return 0;
  }

  // An absolute path is still how a community plugin is named without a
  // source, so answering "not found" for one that loads fine would be wrong.
  try {
    const loaded = createPluginLoader().load(id);
    renderPluginDetails({
      id: loaded.id,
      name: loaded.details.name,
      description: loaded.details.description,
      version: loaded.version,
      source: 'path',
      absPath: loaded.absPath,
      details: loaded.details,
    });
    return 0;
  } catch {
    throw notFound();
  }
};

const cmdPluginSource = async (argv: string[]): Promise<number> => {
  const [sub, ...rest] = argv;
  if (sub === 'add') return cmdPluginSourceAdd(rest);
  if (sub === 'list') return cmdPluginSourceList(rest);
  if (sub === 'remove') return cmdPluginSourceRemove(rest);
  if (sub === 'sync') return cmdPluginSourceSync(rest);
  throw new CliError(
    `Unknown command: "plugin source ${sub ?? ''}". Expected one of: add, list, remove, sync.`,
  );
};

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  trawlarr daemon [--port <n>] [--bind <addr>]
  trawlarr library add --name <name> --root <path> [--root <path>...] [--extensions mkv,mp4] [--allow-hardlinked]
  trawlarr flow add --name <name> --file <flow.json>
  trawlarr flow add --name <name> --template <id> [--set key=value...]
  trawlarr library set-flow --library <name> --flow <name>
  trawlarr scan --library <name> [--allow-empty-roots]
  trawlarr run [--library <name>] [--max <n>]
  trawlarr status [--library <name>] [--files] [--state <state>] [--missing]
  trawlarr requeue --file <id> [--file <id>...]
  trawlarr requeue --library <name> --state <state>
  trawlarr plugin source add --name <name> (--url <https .tar.gz> | --path <dir>)
  trawlarr plugin source list
  trawlarr plugin source sync (--name <name> | --all)
  trawlarr plugin source remove --name <name>
  trawlarr plugin list [--source <name>]
  trawlarr plugin show --id <plugin id>
  trawlarr trash purge [--library <name>] [--days <n>] [--dry-run]
  trawlarr reap [--library <name>] [--stale-after-hours <n>] [--dry-run]
  trawlarr forget --missing [--library <name>] [--include-terminal] [--dry-run]
  trawlarr forget --file <id> [--file <id>...] [--dry-run]

Flow templates: transcode-hevc, conform-library
  e.g. trawlarr flow add --name Movies --template transcode-hevc \
         --set encoder=hevc_nvenc --set quality=22
  conform-library also remuxes, guarantees a stereo AAC track and filters
  audio languages; it needs a synced plugin source and says which plugins.

Installing a plugin runs its author's code as the user trawlarr runs as.

All commands accept --data-dir <path> (default ./trawlarr-data).
While a daemon owns that directory, every command talks to it over its API
instead of opening the database — the daemon is the only writer.`;

const dispatch = async (argv: string[]): Promise<number> => {
  const [cmd, ...rest] = argv;

  // Asking for help is a request, not a mistake. `--help` is the single most
  // common first command anyone types, and answering it with "Unrecognized
  // option" on stderr and a non-zero exit tells a new user they got it
  // wrong while printing exactly what they asked for underneath. The
  // "options must come AFTER the command" diagnostic below is kept intact
  // for what it was written for: a genuinely misplaced option.
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }

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
  if (cmd === 'plugin') {
    const [sub, ...subRest] = rest;
    if (sub === 'source') return cmdPluginSource(subRest);
    if (sub === 'list') return cmdPluginList(subRest);
    if (sub === 'show') return cmdPluginShow(subRest);
    throw new CliError(`Unknown command: "plugin ${sub ?? ''}".\n\n${USAGE}`);
  }
  if (cmd === 'trash') {
    const [sub, ...subRest] = rest;
    if (sub === 'purge') return cmdTrashPurge(subRest);
    throw new CliError(`Unknown command: "trash ${sub ?? ''}".\n\n${USAGE}`);
  }
  if (cmd === 'daemon') return cmdDaemon(rest);
  if (cmd === 'scan') return cmdScan(rest);
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'requeue') return cmdRequeue(rest);
  if (cmd === 'reap') return cmdReap(rest);
  if (cmd === 'forget') return cmdForget(rest);

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
