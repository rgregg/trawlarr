import { describe, expect, it, vi } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { createApiClient } from '../../api/client.js';
import {
  draftBase,
  hasDefinitionChanges,
  initialEditorBuffer,
  isDraftStale,
  loadPublishLibraries,
  summarizePublish,
  type EditorFlow,
} from './flow-editor-model.js';

const definition: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'next', pluginId: 'example:check', pluginVersion: '2', inputs: { codec: 'hevc' } },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'next' }],
};
const flow: EditorFlow = {
  id: 'f',
  name: 'Flow',
  description: null,
  definition,
  definitionHash: 'live',
  draft: null,
  draftBaseHash: null,
  draftUpdatedAt: null,
  layout: {},
};

describe('flow editor lifecycle', () => {
  it('recovers unsaved work after reauthentication without rebasing it onto newer work', () => {
    const recovery = { definition: { ...definition, edges: [] }, baseHash: 'old' };
    expect(initialEditorBuffer(flow, recovery)).toBe(recovery);
    expect(isDraftStale(initialEditorBuffer(flow, recovery).baseHash, flow.definitionHash)).toBe(
      true,
    );
    expect(initialEditorBuffer(flow)).toEqual({ definition, baseHash: 'live' });
    expect(
      initialEditorBuffer({ ...flow, draft: recovery.definition, draftBaseHash: 'old' }),
    ).toEqual(recovery);
  });

  it('keeps a saved draft based on the version it started from, not the latest live hash', () => {
    expect(draftBase(flow)).toBe('live');
    const stale = { ...flow, draft: definition, draftBaseHash: 'old' };
    expect(draftBase(stale)).toBe('old');
    expect(isDraftStale(draftBase(stale), flow.definitionHash)).toBe(true);
    expect(isDraftStale('live', 'live')).toBe(false);
  });

  it('compares complete semantics, not node order or display layout', () => {
    expect(
      hasDefinitionChanges(definition, { ...definition, nodes: [...definition.nodes].reverse() }),
    ).toBe(false);
    expect(hasDefinitionChanges(definition, { ...definition, edges: [] })).toBe(true);
    expect(
      hasDefinitionChanges(definition, {
        ...definition,
        nodes: definition.nodes.map((node) => ({ ...node, pluginVersion: 'new' })),
      }),
    ).toBe(true);
    expect(
      hasDefinitionChanges(definition, {
        ...definition,
        nodes: definition.nodes.map((node) => ({ ...node, inputs: { extra: false } })),
      }),
    ).toBe(true);
  });

  it('does not lose changes to a duplicate node in a half-finished draft', () => {
    const a = { id: 'same', pluginId: 'a', pluginVersion: '1', inputs: {} };
    const b = { ...a, pluginId: 'b' };
    expect(hasDefinitionChanges({ nodes: [a, b], edges: [] }, { nodes: [b, b], edges: [] })).toBe(
      true,
    );
  });

  it('does not promise to requeue terminal files or guess an encode count', () => {
    const libraries = [
      { id: 'a', name: 'A', flowId: 'f', total: 25, terminal: 3 },
      { id: 'b', name: 'B', flowId: 'f', total: 10, terminal: 2 },
    ];
    expect(summarizePublish(libraries, false)).toEqual({
      libraries,
      total: 35,
      terminal: 5,
      eligible: 30,
      unchanged: false,
    });
    expect(summarizePublish(libraries, true).eligible).toBe(0);
    expect(summarizePublish([], false).total).toBe(0);
  });

  it('loads counts only for attached libraries and surfaces any failed count', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'a', name: 'A', flowId: 'f' },
            { id: 'b', name: 'B', flowId: 'other' },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total: 9,
            reviewHeld: 1,
            byState: { failed: 2, not_converging: 1 },
          }),
        ),
      );
    const client = createApiClient({ fetchImpl });
    expect(await loadPublishLibraries(client, 'f')).toEqual([
      { id: 'a', name: 'A', flowId: 'f', total: 9, terminal: 4 },
    ]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/libraries',
      '/api/v1/libraries/a/stats',
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      headers: {},
    });
    fetchImpl
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'a', name: 'A', flowId: 'f' }])))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(loadPublishLibraries(client, 'f')).rejects.toThrow('offline');
  });
});
