import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
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
