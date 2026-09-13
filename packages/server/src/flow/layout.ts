import { FLOW_NODE_NAME_MAX, type FlowLayout, type FlowNodeView } from '@trawlarr/core';

export class InvalidFlowLayoutError extends Error {
  constructor() {
    super(
      'Layout must map non-empty node IDs to positions with finite numeric x and y coordinates, ' +
        `each optionally naming the node with at most ${String(FLOW_NODE_NAME_MAX)} characters.`,
    );
    this.name = 'InvalidFlowLayoutError';
  }
}

export const parseFlowLayout = (value: unknown): FlowLayout => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidFlowLayoutError();
  }
  return Object.fromEntries(
    Object.entries(value).map(([id, position]) => {
      if (
        id === '' ||
        position === null ||
        typeof position !== 'object' ||
        Array.isArray(position) ||
        !('x' in position) ||
        !('y' in position) ||
        typeof position.x !== 'number' ||
        typeof position.y !== 'number' ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      ) {
        throw new InvalidFlowLayoutError();
      }
      const view: FlowNodeView = { x: position.x, y: position.y };
      if ('name' in position && position.name !== undefined) {
        if (typeof position.name !== 'string' || position.name.length > FLOW_NODE_NAME_MAX) {
          throw new InvalidFlowLayoutError();
        }
        // A blank name is not a name: storing one would say "this node is
        // called nothing" where the absent key says "call it what the plugin
        // calls it", and the canvas has to render something either way.
        if (position.name.trim() !== '') view.name = position.name;
      }
      return [id, view];
    }),
  );
};
