import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { createPluginLoader } from '@trawlarr/engine';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createPluginRepo } from '../plugins/plugin-repo.js';
import { createEventBus, type TrawlarrEvent } from './events.js';
import {
  PAUSE_PREFIX_FLOW,
  PAUSE_PREFIX_OPERATOR,
  checkAllLibraries,
  checkLibraryHealth,
} from './library-health.js';

const NOW = 1_700_000_000_000;

/** A minimal, genuinely runnable flow: a start node and nothing else. */
const VALID_FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

/** One node naming a plugin id nothing on this host can resolve, and no edges. */
const flowUsing = (pluginId: string): FlowDefinition => ({
  nodes: [{ id: 'n1', pluginId, pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
});

/**
 * A real, loadable CommonJS flow plugin — the fixture the installed cases
 * need, because the resolver they exercise proves itself by LOADING the file
 * the registry names and reading its `details()`.
 */
const FIXTURE_PLUGIN = `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'x',
  style: { borderColor: '#fff' },
  tags: '',
  isStartPlugin: true,
  pType: 'start',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
`;

/** Writes the fixture to disk and installs it as `fx:myPlugin`. Returns its id. */
const installFixturePlugin = (): { pluginId: string; absPath: string; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-hp-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  const absPath = join(dir, 'index.js');
  writeFileSync(absPath, FIXTURE_PLUGIN, 'utf8');

  const repo = createPluginRepo(db);
  repo.addSource({ id: 'fx', url: root, kind: 'local' });
  repo.replaceSourcePlugins('fx', [
    {
      pluginName: 'myPlugin',
      relPath: join('p', 'myPlugin', '1.0.0', 'index.js'),
      absPath,
      version: '1.0.0',
      details: createPluginLoader().load(absPath).details,
    },
  ]);
  return { pluginId: 'fx:myPlugin', absPath, root };
};

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

const seedLibrary = (input: { flowId?: string | null }): LibraryRecord =>
  createLibraryRepo(db).create({
    name: `lib-${Math.random().toString(36).slice(2)}`,
    roots: [`/media/${Math.random().toString(36).slice(2)}`],
    flowId: input.flowId ?? null,
    nowMs: NOW,
  });

const seedLibraryWithFlowUsing = (pluginId: string): { libraryId: string } => {
  const flow = createFlowRepo(db).create({
    name: 'unresolvable',
    definition: flowUsing(pluginId),
    nowMs: NOW,
  });
  const library = seedLibrary({ flowId: flow.id });
  return { libraryId: library.id };
};

const seedLibraryWithValidFlow = (): { libraryId: string } => {
  const flow = createFlowRepo(db).create({ name: 'valid', definition: VALID_FLOW, nowMs: NOW });
  const library = seedLibrary({ flowId: flow.id });
  return { libraryId: library.id };
};

const seedLibraryWithNoFlow = (): { libraryId: string } => {
  const library = seedLibrary({ flowId: null });
  return { libraryId: library.id };
};

const attachValidFlow = (libraryId: string): void => {
  const flow = createFlowRepo(db).create({
    name: `valid-${Math.random().toString(36).slice(2)}`,
    definition: VALID_FLOW,
    nowMs: NOW,
  });
  createLibraryRepo(db).setFlow(libraryId, flow.id);
};

describe('checkLibraryHealth', () => {
  it('pauses a library whose flow references a plugin this host cannot resolve, naming it', () => {
    const bus = createEventBus();
    const { libraryId } = seedLibraryWithFlowUsing('community:doesNotExist');

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('community:doesNotExist');
    const library = createLibraryRepo(db).getById(libraryId)!;
    expect(library.enabled).toBe(false);
    expect(library.pausedReason?.startsWith(PAUSE_PREFIX_FLOW)).toBe(true);
  });

  it('does not pause a library whose flow uses an INSTALLED plugin', () => {
    // THE PAIR MATTERS: the sibling test above asserts an UNRESOLVABLE plugin
    // DOES pause the library. A resolver that resolves everything passes this
    // one and fails that; a resolver that resolves nothing does the reverse.
    // Neither test alone can tell a working resolver from a broken one.
    const bus = createEventBus();
    const { pluginId, root } = installFixturePlugin();
    const { libraryId } = seedLibraryWithFlowUsing(pluginId);

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    const library = createLibraryRepo(db).getById(libraryId)!;
    expect(library.enabled).toBe(true);
    expect(library.pausedReason).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('pauses a library again once the plugin its flow uses is uninstalled', () => {
    // The consistent answer to "referenced but no longer installed": the same
    // unresolvable-plugin reason, naming the id, that a never-installed
    // plugin gets. Self-clearing health means no human has to notice.
    const bus = createEventBus();
    const { pluginId, root } = installFixturePlugin();
    const { libraryId } = seedLibraryWithFlowUsing(pluginId);
    expect(checkLibraryHealth({ db, libraryId, bus }).ok).toBe(true);

    createPluginRepo(db).removeSource('fx');
    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(pluginId);
    expect(result.reason).toContain('cannot');
    expect(createLibraryRepo(db).getById(libraryId)!.enabled).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('pauses a library whose installed plugin row outlived its file on disk', () => {
    // A row can outlive its files (a source directory deleted from under it).
    // The registry resolves the id, the LOADER then fails, and the answer is
    // the same one wording as never having installed it — not a crash, and
    // not a false green.
    const bus = createEventBus();
    const { pluginId, root } = installFixturePlugin();
    const { libraryId } = seedLibraryWithFlowUsing(pluginId);
    rmSync(root, { recursive: true, force: true });

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(pluginId);
    expect(createLibraryRepo(db).getById(libraryId)!.enabled).toBe(false);
  });

  it('resumes a library once its flow becomes valid again', () => {
    const bus = createEventBus();
    const { libraryId } = seedLibraryWithFlowUsing('community:doesNotExist');
    checkLibraryHealth({ db, libraryId, bus });

    attachValidFlow(libraryId);
    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(true);
    expect(createLibraryRepo(db).getById(libraryId)!.enabled).toBe(true);
    expect(createLibraryRepo(db).getById(libraryId)!.pausedReason).toBeNull();
  });

  it('never resumes a library an operator paused, however healthy its flow is', () => {
    const bus = createEventBus();
    const { libraryId } = seedLibraryWithValidFlow();
    createLibraryRepo(db).pause(libraryId, `${PAUSE_PREFIX_OPERATOR}disk replacement`);

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(true);
    const library = createLibraryRepo(db).getById(libraryId)!;
    expect(library.enabled).toBe(false);
    expect(library.pausedReason).toBe(`${PAUSE_PREFIX_OPERATOR}disk replacement`);
  });

  it('never overwrites an operator pause with a flow reason, even when the flow is also broken', () => {
    const bus = createEventBus();
    const { libraryId } = seedLibraryWithFlowUsing('community:doesNotExist');
    createLibraryRepo(db).pause(libraryId, `${PAUSE_PREFIX_OPERATOR}awaiting disk swap`);

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.changed).toBe(false);
    const library = createLibraryRepo(db).getById(libraryId)!;
    expect(library.pausedReason).toBe(`${PAUSE_PREFIX_OPERATOR}awaiting disk swap`);
  });

  it('pauses a library with no flow attached, and says what to run', () => {
    const bus = createEventBus();
    const { libraryId } = seedLibraryWithNoFlow();

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('set-flow');
    expect(result.reason?.startsWith(PAUSE_PREFIX_FLOW)).toBe(true);
  });

  it('pauses a library whose flowId points at a flow row that no longer exists', () => {
    // `flow_id` is `ON DELETE SET NULL`, and nothing in this codebase deletes
    // a flow row anyway (`FlowRepo` has no delete), so this state cannot
    // arise through the app today. It is still checked for defensively: the
    // constraint is a property of THIS schema, not a law of nature, and a
    // library whose flow vanished must never be left silently unrunnable
    // instead of paused. Reproduced here by turning the constraint off for
    // one write, exactly as a stale row from a schema change might land.
    const bus = createEventBus();
    const flow = createFlowRepo(db).create({ name: 'temp', definition: VALID_FLOW, nowMs: NOW });
    const library = seedLibrary({ flowId: flow.id });
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM flow WHERE id = ?`).run(flow.id);
    db.pragma('foreign_keys = ON');

    const result = checkLibraryHealth({ db, libraryId: library.id, bus });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(flow.id);
    expect(createLibraryRepo(db).getById(library.id)!.enabled).toBe(false);
  });

  it('leaves a healthy, never-paused library untouched', () => {
    const bus = createEventBus();
    const { libraryId } = seedLibraryWithValidFlow();

    const result = checkLibraryHealth({ db, libraryId, bus });

    expect(result).toEqual({ libraryId, ok: true, reason: null, changed: false });
    expect(createLibraryRepo(db).getById(libraryId)!.enabled).toBe(true);
  });

  it('emits library.paused once, not on every re-check of an already-paused library', () => {
    const bus = createEventBus();
    const events: TrawlarrEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const { libraryId } = seedLibraryWithFlowUsing('community:doesNotExist');

    checkLibraryHealth({ db, libraryId, bus });
    checkLibraryHealth({ db, libraryId, bus });
    checkLibraryHealth({ db, libraryId, bus });

    expect(events.filter((event) => event.type === 'library.paused')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'library.resumed')).toHaveLength(0);
  });

  it('emits library.resumed once when a broken flow is fixed, not again on the next healthy check', () => {
    const bus = createEventBus();
    const events: TrawlarrEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const { libraryId } = seedLibraryWithFlowUsing('community:doesNotExist');
    checkLibraryHealth({ db, libraryId, bus });

    attachValidFlow(libraryId);
    checkLibraryHealth({ db, libraryId, bus });
    checkLibraryHealth({ db, libraryId, bus });

    expect(events.filter((event) => event.type === 'library.paused')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'library.resumed')).toHaveLength(1);
  });
});

describe('checkAllLibraries', () => {
  it('checks every library and returns one result per library, asymmetrically', () => {
    const bus = createEventBus();
    const { libraryId: broken } = seedLibraryWithFlowUsing('community:doesNotExist');
    const { libraryId: healthy } = seedLibraryWithValidFlow();
    const { libraryId: unset } = seedLibraryWithNoFlow();

    const results = checkAllLibraries({ db, bus });

    expect(results).toHaveLength(3);
    const byId = new Map(results.map((result) => [result.libraryId, result]));
    expect(byId.get(broken)?.ok).toBe(false);
    expect(byId.get(healthy)?.ok).toBe(true);
    expect(byId.get(unset)?.ok).toBe(false);
    expect(byId.get(unset)?.reason).toContain('set-flow');
    expect(byId.get(broken)?.reason).toContain('community:doesNotExist');
  });
});
