import type { FlowLayout } from '@trawlarr/core';

export class InvalidFlowLayoutError extends Error {
  constructor() {
    super(
      'Layout must map non-empty node IDs to positions with finite numeric x and y coordinates.',
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
      return [id, { x: position.x, y: position.y }];
    }),
  );
};
