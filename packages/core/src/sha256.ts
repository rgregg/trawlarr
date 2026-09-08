import { createHash } from 'node:crypto';

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');
