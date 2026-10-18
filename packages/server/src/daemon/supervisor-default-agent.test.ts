import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFacts, type FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase } from '../db/connection.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { migrate } from '../db/migrate.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import { fakeChild, type FakeChild } from '../../test/fake-child.js';
import { createEventBus } from './events.js';
import { createSupervisor } from './supervisor.js';

/**
 * The supervisor's DEFAULT agent factory, with only the fork itself faked.
 *
 * Every other supervisor test hands in its own `createAgent`, so the line that passes `onAlert`
 * from the factory input to the real `createAgentHandle` was covered by nothing: dropping it
 * would have silently lost every local Send Webhook alert.
 */
const forked = vi.hoisted(() => ({ children: [] as unknown[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    fork: () => {
      // No pid: a made-up one could be handed to a real process-group kill.
      const child = fakeChild();
      forked.children.push(child);
      return child;
    },
  };
});

const NOW = Date.UTC(2024, 0, 1, 0, 30);
const PROBE: ProbeData = {
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
  format: { duration: '60.0', size: '4096', bit_rate: '16384' },
};
const FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

afterEach(() => {
  for (const child of forked.children.splice(0)) (child as FakeChild).die(1, null);
});

describe('the supervisor with its default agent factory', () => {
  it("hands a forked agent's alert-request to raiseFlowMessage with the job's own context", async () => {
    const db = openDatabase({ file: ':memory:' });
    migrate(db);
    const settings = createSettingsRepo({ db });
    settings.setHardware({ available: ['cpu'], caps: {} });
    settings.setSchedule({
      timezone: 'UTC',
      baseCounts: { transcode: 1, health: 0 },
      windows: [],
    });
    const flow = createFlowRepo(db).create({ name: 'F', definition: FLOW, nowMs: NOW });
    const library = createLibraryRepo(db).create({
      name: 'Movies',
      roots: ['/media/m'],
      flowId: flow.id,
      nowMs: NOW,
    });
    const files = createMediaFileRepo(db);
    const fileId = files.upsertScanned({
      libraryId: library.id,
      identity: { inodeKey: '2049:1', contentKey: '4096:1:ff' },
      path: '/media/m/a.mkv',
      nlink: 1,
      sizeBytes: 4096,
      mtimeMs: NOW,
      ctimeMs: NOW,
      container: 'mkv',
      nowMs: NOW,
    });
    files.setProbe({
      fileId,
      probe: PROBE,
      facts: extractFacts({ probe: PROBE, container: 'mkv', sizeBytes: 4096 }),
    });
    files.setState({ fileId, state: 'queued' });

    const raised: unknown[] = [];
    const supervisor = createSupervisor({
      db,
      bus: createEventBus(),
      settings,
      nowMs: () => NOW,
      remoteNodes: () => [],
      createRemoteAgent: () => {
        throw new Error('no remote nodes here');
      },
      raiseFlowMessage: (request) => {
        raised.push(request);
        return 'queued';
      },
    });

    await supervisor.tick();
    expect(forked.children).toHaveLength(1);
    const child = forked.children[0] as FakeChild;

    child.emit('message', { type: 'alert-request', destination: 'ha', message: 'hi' });

    expect(raised).toEqual([
      {
        destination: 'ha',
        message: 'hi',
        library: 'Movies',
        path: '/media/m/a.mkv',
        jobId: expect.any(String) as unknown,
      },
    ]);
  });
});
