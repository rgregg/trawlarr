import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The identity a `trawlarr node` process was enrolled with: which server it
 * belongs to, the nodeId the server knows it by, and the shared secret it
 * authenticates the node socket with. `node.json` is written 0o600 because
 * the secret in it is a bearer credential for that node's identity — anyone
 * who can read it can impersonate the node to the server.
 */
export interface NodeState {
  serverUrl: string;
  nodeId: string;
  secret: string;
}

const FILE_NAME = 'node.json';
const FILE_MODE = 0o600;

const isNodeState = (value: unknown): value is NodeState => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['serverUrl'] === 'string' &&
    typeof record['nodeId'] === 'string' &&
    typeof record['secret'] === 'string'
  );
};

export const readNodeState = async (dataDir: string): Promise<NodeState | null> => {
  const path = join(dataDir, FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Malformed node state file "${path}": not valid JSON.`);
  }
  if (!isNodeState(parsed)) {
    throw new Error(`Malformed node state file "${path}": missing serverUrl, nodeId or secret.`);
  }
  return parsed;
};

/**
 * Write-to-temp + rename, with the temp file itself created 0o600 (never
 * created world-readable and chmod'd afterward — that leaves a window where
 * the secret is readable by anyone before the permission tightens).
 */
export const writeNodeState = async (dataDir: string, state: NodeState): Promise<void> => {
  const path = join(dataDir, FILE_NAME);
  const tmp = join(dataDir, `.${FILE_NAME}.tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, JSON.stringify(state), { mode: FILE_MODE });
  await rename(tmp, path);
};
