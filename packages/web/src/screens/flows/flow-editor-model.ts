import type { FlowDefinition, FlowLayout } from '@trawlarr/core';
import type { ApiClient } from '../../api/client.js';

export interface EditorFlow {
  id: string;
  name: string;
  description: string | null;
  definition: FlowDefinition;
  definitionHash: string;
  draft: FlowDefinition | null;
  draftBaseHash: string | null;
  draftUpdatedAt: number | null;
  layout: FlowLayout;
}

export interface FlowLibrary {
  id: string;
  name: string;
  flowId: string | null;
}

export interface PublishLibrary extends FlowLibrary {
  total: number;
  terminal: number;
}

export interface EditorBuffer {
  definition: FlowDefinition;
  baseHash: string;
}

/**
 * Outside the auth-gated tree: an automatic 401 unmounts that tree before
 * any navigation prompt can run. Keep unsaved work in this tab's memory,
 * never localStorage, so reauthentication does not destroy the graph.
 */
export const editorBuffers = new Map<string, EditorBuffer>();

export const initialEditorBuffer = (flow: EditorFlow, recovery?: EditorBuffer): EditorBuffer =>
  recovery ?? { definition: flow.draft ?? flow.definition, baseHash: draftBase(flow) };

export const draftBase = (flow: EditorFlow): string => flow.draftBaseHash ?? flow.definitionHash;

export const isDraftStale = (baseHash: string, liveHash: string): boolean => baseHash !== liveHash;

const definitionSnapshot = (definition: FlowDefinition): string =>
  JSON.stringify({
    nodes: definition.nodes.map((node) => JSON.stringify(node)).sort(),
    edges: definition.edges.map((edge) => JSON.stringify(edge)).sort(),
  });

// Compare complete records, including duplicate IDs in invalid drafts. A
// Map-based graph diff drops duplicates and can miss unsaved work.
export const hasDefinitionChanges = (left: FlowDefinition, right: FlowDefinition): boolean =>
  definitionSnapshot(left) !== definitionSnapshot(right);

export const summarizePublish = (libraries: PublishLibrary[], unchanged: boolean) => ({
  libraries,
  total: libraries.reduce((sum, library) => sum + library.total, 0),
  terminal: libraries.reduce((sum, library) => sum + library.terminal, 0),
  eligible: unchanged
    ? 0
    : libraries.reduce((sum, library) => sum + library.total - library.terminal, 0),
  unchanged,
});

export const loadPublishLibraries = async (
  client: ApiClient,
  flowId: string,
): Promise<PublishLibrary[]> => {
  const libraries = await client.get<FlowLibrary[]>('/libraries');
  return await Promise.all(
    libraries
      .filter((library) => library.flowId === flowId)
      .map(async (library) => {
        const stats = await client.get<{
          total: number;
          byState: { failed: number; not_converging: number };
          reviewHeld: number;
        }>(`/libraries/${encodeURIComponent(library.id)}/stats`);
        return {
          ...library,
          total: stats.total,
          terminal: stats.byState.failed + stats.byState.not_converging + stats.reviewHeld,
        };
      }),
  );
};
