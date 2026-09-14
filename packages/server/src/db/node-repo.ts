import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SCHEDULE,
  validateSchedule,
  validatePathMap,
  type HardwareType,
  type PathMapping,
  type ScheduleConfig,
} from '@trawlarr/core';
import { hashPassword, verifyPassword } from '../api/password.js';
import type { Db } from './connection.js';

export interface NodeLibraryProbe {
  libraryId: string;
  reachable: boolean;
  detail: string;
}

export interface NodeRecord {
  id: string;
  name: string;
  accessMode: 'direct' | 'transfer';
  pathMap: PathMapping[];
  hardwareTypes: HardwareType[];
  hardwareCaps: Partial<Record<HardwareType, number>>;
  tags: string;
  lastSeenAt: number | null;
  /** worker_config_json; DEFAULT_SCHEDULE when unset. */
  schedule: ScheduleConfig;
  paused: boolean;
  buildVersion: string | null;
  ffmpeg: { ffmpegPath: string; ffprobePath: string } | null;
  /** Last probe results. */
  libraries: NodeLibraryProbe[];
  revokedAt: number | null;
  /** secret_hash IS NOT NULL. */
  enrolled: boolean;
  enrollExpiresAt: number | null;
}

export interface NodeRepo {
  list(): NodeRecord[];
  getById(id: string): NodeRecord | null;
  create(input: {
    name: string;
    nowMs: number;
  }): Promise<{ node: NodeRecord; enrollToken: string }>;
  regenerateEnrollToken(input: {
    id: string;
    nowMs: number;
  }): Promise<{ enrollToken: string; expiresAt: number }>;
  /** Consumes the token. Returns null for unknown/expired/used/revoked. */
  enroll(input: {
    token: string;
    nowMs: number;
  }): Promise<{ nodeId: string; secret: string } | null>;
  /** True only for the right secret of an enrolled, unrevoked node. */
  authenticate(input: { nodeId: string; secret: string }): Promise<boolean>;
  update(
    id: string,
    patch: {
      name?: string;
      pathMap?: unknown;
      schedule?: ScheduleConfig;
      paused?: boolean;
      tags?: string;
    },
  ): NodeRecord;
  recordHello(
    id: string,
    hello: {
      buildVersion: string;
      hardwareTypes: HardwareType[];
      hardwareCaps: Partial<Record<HardwareType, number>>;
      ffmpegPath: string;
      ffprobePath: string;
      nowMs: number;
    },
  ): void;
  recordLibraries(id: string, libraries: NodeLibraryProbe[]): void;
  touch(id: string, nowMs: number): void;
  revoke(id: string, nowMs: number): void;
  /** Throws NodeRepoError if the node has an unended job. */
  remove(id: string): void;
}

export class NodeRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeRepoError';
  }
}

/**
 * The name `ensureLocalNode` (`api/routes/nodes.ts`) has always used for the
 * single local-node row. A newly created remote node must never collide with
 * it, so the name is reserved outright rather than merely checked for
 * uniqueness against whatever happens to be in the table at the time.
 */
const RESERVED_NODE_NAME = 'local';

const ENROLL_TOKEN_TTL_MS = 24 * 3_600_000;

const NODE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * `node-` + 12 lowercase base32 characters. The alphabet has exactly 32
 * symbols, so indexing a random byte modulo 32 introduces no bias (256 is
 * evenly divisible by 32) while staying far simpler than real bit-packing
 * base32 -- there is no need to decode this id, only to generate one that
 * reads and types cleanly.
 */
const generateNodeId = (): string => {
  const bytes = randomBytes(12);
  let suffix = '';
  for (let i = 0; i < 12; i += 1) {
    suffix += NODE_ID_ALPHABET[(bytes[i] as number) % 32];
  }
  return `node-${suffix}`;
};

const generateToken = (prefix: string): string =>
  `${prefix}${randomBytes(32).toString('base64url')}`;

interface NodeRowRaw {
  id: string;
  name: string;
  access_mode: string;
  path_map_json: string;
  hardware_types_json: string;
  hardware_caps_json: string;
  tags: string;
  last_seen_at: number | null;
  worker_config_json: string | null;
  paused: number;
  build_version: string | null;
  ffmpeg_json: string | null;
  libraries_json: string;
  revoked_at: number | null;
  secret_hash: string | null;
  enroll_token_hash: string | null;
  enroll_expires_at: number | null;
}

const scheduleFromRow = (workerConfigJson: string | null): ScheduleConfig => {
  if (workerConfigJson === null) return DEFAULT_SCHEDULE;
  const parsed = JSON.parse(workerConfigJson) as ScheduleConfig;
  validateSchedule(parsed);
  return parsed;
};

const toRecord = (row: NodeRowRaw): NodeRecord => ({
  id: row.id,
  name: row.name,
  accessMode: row.access_mode as 'direct' | 'transfer',
  pathMap: JSON.parse(row.path_map_json) as PathMapping[],
  hardwareTypes: JSON.parse(row.hardware_types_json) as HardwareType[],
  hardwareCaps: JSON.parse(row.hardware_caps_json) as Partial<Record<HardwareType, number>>,
  tags: row.tags,
  lastSeenAt: row.last_seen_at,
  schedule: scheduleFromRow(row.worker_config_json),
  paused: row.paused === 1,
  buildVersion: row.build_version,
  ffmpeg: row.ffmpeg_json === null ? null : (JSON.parse(row.ffmpeg_json) as NodeRecord['ffmpeg']),
  libraries: JSON.parse(row.libraries_json) as NodeLibraryProbe[],
  revokedAt: row.revoked_at,
  enrolled: row.secret_hash !== null,
  enrollExpiresAt: row.enroll_expires_at,
});

export const createNodeRepo = (db: Db): NodeRepo => {
  const selectById = db.prepare(`SELECT * FROM node WHERE id = ?`);
  const selectAll = db.prepare(`SELECT * FROM node ORDER BY id`);
  const selectByName = db.prepare(`SELECT id FROM node WHERE name = ?`);
  const selectByNameExcluding = db.prepare(`SELECT id FROM node WHERE name = ? AND id != ?`);

  const getRow = (id: string): NodeRowRaw | undefined =>
    selectById.get(id) as NodeRowRaw | undefined;

  const requireRow = (id: string): NodeRowRaw => {
    const row = getRow(id);
    if (row === undefined) throw new NodeRepoError(`Unknown node "${id}".`);
    return row;
  };

  const checkNameAvailable = (name: string, excludingId?: string): void => {
    if (name === '') throw new NodeRepoError('Node name must not be empty.');
    if (name === RESERVED_NODE_NAME) {
      throw new NodeRepoError(`Node name "${RESERVED_NODE_NAME}" is reserved for the local node.`);
    }
    const clash =
      excludingId === undefined
        ? (selectByName.get(name) as { id: string } | undefined)
        : (selectByNameExcluding.get(name, excludingId) as { id: string } | undefined);
    if (clash !== undefined) throw new NodeRepoError(`A node named "${name}" already exists.`);
  };

  const insertNode = db.prepare(
    `INSERT INTO node (id, name, access_mode, path_map_json, hardware_types_json, tags, enroll_token_hash, enroll_expires_at)
     VALUES (?, ?, 'direct', '[]', '["cpu"]', '', ?, ?)`,
  );

  const updateEnrollToken = db.prepare(
    `UPDATE node SET enroll_token_hash = ?, enroll_expires_at = ? WHERE id = ?`,
  );

  // The WHERE clause repeats every condition `selectEnrollCandidates` used to
  // pick this row, plus `enroll_expires_at > ?` again with the SAME nowMs:
  // two concurrent `enroll()` calls for the same token both pass the SELECT
  // and both verify the password (verifyPassword does no locking), so
  // without this the second UPDATE would silently overwrite the first
  // caller's secret_hash -- both callers get a `{nodeId, secret}` back, but
  // only the second caller's secret would ever authenticate. Checking
  // `changes` below is what lets the loser learn it lost.
  const clearEnrollAndSetSecret = db.prepare(
    `UPDATE node SET secret_hash = ?, enroll_token_hash = NULL, enroll_expires_at = NULL
     WHERE id = ? AND secret_hash IS NULL AND revoked_at IS NULL AND enroll_expires_at > ?`,
  );

  const selectEnrollCandidates = db.prepare(
    `SELECT id, enroll_token_hash FROM node
     WHERE enroll_expires_at > ? AND secret_hash IS NULL AND revoked_at IS NULL`,
  );

  const updateNode = db.prepare(
    `UPDATE node SET name = ?, path_map_json = ?, worker_config_json = ?, paused = ?, tags = ? WHERE id = ?`,
  );

  const revokeNode = db.prepare(`UPDATE node SET revoked_at = ? WHERE id = ?`);
  const touchNode = db.prepare(`UPDATE node SET last_seen_at = ? WHERE id = ?`);
  const deleteNode = db.prepare(`DELETE FROM node WHERE id = ?`);
  const selectRunningJobForNode = db.prepare(
    `SELECT id FROM job WHERE node_id = ? AND ended_at IS NULL LIMIT 1`,
  );

  const recordHelloStmt = db.prepare(
    `UPDATE node SET build_version = ?, hardware_types_json = ?, hardware_caps_json = ?, ffmpeg_json = ?, last_seen_at = ?
     WHERE id = ?`,
  );
  const recordLibrariesStmt = db.prepare(`UPDATE node SET libraries_json = ? WHERE id = ?`);

  return {
    list() {
      return (selectAll.all() as NodeRowRaw[]).map(toRecord);
    },

    getById(id) {
      const row = getRow(id);
      return row === undefined ? null : toRecord(row);
    },

    async create(input) {
      const name = input.name.trim();
      checkNameAvailable(name);
      const enrollToken = generateToken('tnode_enroll_');
      const enrollTokenHash = await hashPassword(enrollToken);
      // Re-checked right before the write: `hashPassword` awaits, and another
      // `create` call for the same name could have committed during that
      // await. The gap between this check and the INSERT below is now
      // synchronous, so nothing can land in between.
      checkNameAvailable(name);
      const id = generateNodeId();
      insertNode.run(id, name, enrollTokenHash, input.nowMs + ENROLL_TOKEN_TTL_MS);
      return { node: toRecord(requireRow(id)), enrollToken };
    },

    async regenerateEnrollToken(input) {
      requireRow(input.id);
      const enrollToken = generateToken('tnode_enroll_');
      const enrollTokenHash = await hashPassword(enrollToken);
      const expiresAt = input.nowMs + ENROLL_TOKEN_TTL_MS;
      updateEnrollToken.run(enrollTokenHash, expiresAt, input.id);
      return { enrollToken, expiresAt };
    },

    async enroll(input) {
      // Few nodes are ever mid-enrollment at once, so a scan across
      // candidates (rather than looking the token up by id, which the node
      // does not have yet) is fine -- see the brief's authenticate() note
      // for why the CONNECTED path avoids exactly this scan.
      const candidates = selectEnrollCandidates.all(input.nowMs) as {
        id: string;
        enroll_token_hash: string;
      }[];
      for (const candidate of candidates) {
        if (await verifyPassword({ password: input.token, hash: candidate.enroll_token_hash })) {
          const secret = generateToken('tnode_');
          const secretHash = await hashPassword(secret);
          const result = clearEnrollAndSetSecret.run(secretHash, candidate.id, input.nowMs);
          // A concurrent `enroll()` for the same token could have consumed
          // it (or a `revoke()` landed) during the two awaits above; the
          // conditional UPDATE then matches no row, and this caller lost the
          // race rather than the token being unknown.
          if (result.changes === 0) return null;
          return { nodeId: candidate.id, secret };
        }
      }
      return null;
    },

    async authenticate(input) {
      const row = getRow(input.nodeId);
      if (row === undefined || row.secret_hash === null || row.revoked_at !== null) return false;
      return await verifyPassword({ password: input.secret, hash: row.secret_hash });
    },

    // Throws `PathMapError` for an invalid `pathMap`, `ScheduleConfigError`
    // for an invalid `schedule`, and `NodeRepoError` for a name conflict --
    // three distinct error classes, deliberately not collapsed into one, so
    // a caller (the Task 7 route) can map each to its own 400 message.
    update(id, patch) {
      const current = requireRow(id);
      const name = patch.name === undefined ? current.name : patch.name.trim();
      if (patch.name !== undefined) checkNameAvailable(name, id);

      const pathMap =
        patch.pathMap === undefined
          ? (JSON.parse(current.path_map_json) as PathMapping[])
          : validatePathMap(patch.pathMap);

      let scheduleJson = current.worker_config_json;
      if (patch.schedule !== undefined) {
        validateSchedule(patch.schedule);
        scheduleJson = JSON.stringify(patch.schedule);
      }

      const paused = patch.paused === undefined ? current.paused === 1 : patch.paused;
      const tags = patch.tags === undefined ? current.tags : patch.tags;

      updateNode.run(name, JSON.stringify(pathMap), scheduleJson, paused ? 1 : 0, tags, id);
      return toRecord(requireRow(id));
    },

    recordHello(id, hello) {
      recordHelloStmt.run(
        hello.buildVersion,
        JSON.stringify(hello.hardwareTypes),
        JSON.stringify(hello.hardwareCaps),
        JSON.stringify({ ffmpegPath: hello.ffmpegPath, ffprobePath: hello.ffprobePath }),
        hello.nowMs,
        id,
      );
    },

    recordLibraries(id, libraries) {
      recordLibrariesStmt.run(JSON.stringify(libraries), id);
    },

    touch(id, nowMs) {
      touchNode.run(nowMs, id);
    },

    revoke(id, nowMs) {
      revokeNode.run(nowMs, id);
    },

    remove(id) {
      const running = selectRunningJobForNode.get(id) as { id: string } | undefined;
      if (running !== undefined) {
        throw new NodeRepoError(
          `Node "${id}" has a running job (${running.id}); it cannot be removed until that job ends.`,
        );
      }
      deleteNode.run(id);
    },
  };
};
