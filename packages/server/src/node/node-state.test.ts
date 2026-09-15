import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNodeState, writeNodeState } from './node-state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trawlarr-node-state-'));
});

afterEach(() => {
  // Best-effort; leaked temp dirs on failure are not worth failing over.
});

describe('node-state', () => {
  it('round-trips the state', async () => {
    const state = { serverUrl: 'https://server.example', nodeId: 'node-1', secret: 'shh' };
    await writeNodeState(dir, state);
    await expect(readNodeState(dir)).resolves.toEqual(state);
  });

  it('writes node.json with mode 0o600', async () => {
    await writeNodeState(dir, { serverUrl: 'https://x', nodeId: 'n', secret: 's' });
    const mode = statSync(join(dir, 'node.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null when the file is missing', async () => {
    await expect(readNodeState(dir)).resolves.toBeNull();
  });

  it('throws naming the file when the JSON is malformed', async () => {
    writeFileSync(join(dir, 'node.json'), '{not json');
    await expect(readNodeState(dir)).rejects.toThrow(join(dir, 'node.json'));
  });
});
