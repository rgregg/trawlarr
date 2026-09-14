# Remote worker nodes

Status: approved 2026-09-13.

## Problem

Every worker runs on the daemon's host. A library on a NAS cannot borrow a GPU
in another machine, and a large backlog cannot be spread across idle hosts.
The main design (spec §3.1, §4.8, §8 v1.2) reserved this: workers never open
the database, the job input is one plain-JSON payload (`job-payload.ts`), and
`worker/protocol.ts` is a versioned wire format meant to run over a WebSocket.
None of the network half exists: there is no transport, no remote entry point,
no node registration, no path mapping, and no answer to what happens when a
remote node goes quiet in the middle of a transcode.

## Outcome

- A user adds a node in the UI, pastes the command it shows onto another
  machine (or runs the image with `TRAWLARR_MODE=node`), and that machine
  starts taking jobs.
- **Direct access** (phase 1): the node mounts the same library, perhaps at
  different paths, and a per-node mapping table translates them.
- **File transfer** (phase 2): the node has no mount; the server sends it the
  file and installs the result.
- A dropped connection does not throw away an in-flight transcode, and it can
  never let two workers install over the same file.

## Decisions

| Question | Decision |
| --- | --- |
| File access | Direct access first; File transfer designed here, built second |
| Plugin code | Server ships it by content hash; nodes cache it |
| Node auth | One-time enrollment token exchanged for a per-node secret; per-node revoke |
| Disconnect mid-job | Node keeps running and re-attaches; the claim is held for a grace window |
| Worker counts, schedule, tags, path map | Configured per node on the server (as Tdarr does) |
| Hardware, ffmpeg paths | Declared by the node from its own preflight |
| Transport shape | Node host relays to locally forked agents (below, "Approach") |

## Approach

A new `trawlarr node` process runs on the remote host. It opens one outbound
WebSocket to the daemon and, per job, forks the existing `worker/agent.ts`
exactly as the daemon does today, relaying protocol messages between that
agent's IPC channel and the socket.

On the daemon, `RemoteAgentHandle` implements the existing `AgentHandle`
interface over that socket. The supervisor keeps doing every claim in SQLite;
it now claims for "a free slot on node X", and hands the claim to either a
forked local handle or a remote one.

What this buys is the single code path spec §3.1 asked for: `agent.ts`,
`runPayload`, and the message shapes in `protocol.ts` are the same code on
both kinds of node. The only additions on the run path are path rewriting,
plugin fetching, and the commit gate.

Rejected:

- **Nodes poll REST for work.** Cancel, the plugin document-store round trips,
  and re-attach would all be rebuilt on polling — a second protocol beside the
  IPC one, which is the local-works-remote-rots divergence the main spec warns
  about.
- **The local node also becomes a loopback socket node.** Purest, but rewrites
  the worker path production runs on for no user-visible gain. Revisit if the
  two handle implementations drift.

## Architecture

### Packages

Phase 1 keeps the node host in `packages/server` (`src/node/`), for the reason
`agent.ts` already records: the run path needs `probeFile`, the staging and
trash resolvers and the Replace seams, which live there. The node host imports
nothing under `src/db/`, and the existing module-graph test that guards
`agent.ts` is extended to cover `src/node/`.

`trawlarr node` is a CLI subcommand; the Docker entrypoint selects it with
`TRAWLARR_MODE=node`.

### Connection and handshake

- Endpoint: `GET /api/v1/nodes/connect`, upgraded to a WebSocket on the API
  port. The events socket (`/api/v1/events`) is unchanged and stays UI-only.
- Auth: `Authorization: Bearer <node secret>`. Enrollment is a separate REST
  call (see Enrollment). User sessions and the API key are not accepted here,
  and a node secret is not accepted anywhere else.
- The node sends `hello`:
  - `protocolVersion`, `buildVersion`
  - `hardware` (types and caps from the node's own preflight)
  - `ffmpegPath`, `ffprobePath`
  - `jobs`: the node's journal (see Re-attach)
- The server replies `welcome` with the node's config (worker counts and
  schedule, path map, library roots to probe), or `refused` with a reason and
  closes. A `protocolVersion` mismatch is refused with both versions named; the
  node logs it and retries slowly rather than hot-looping.
- After `welcome` the node probes each mapped library root and sends
  `libraries: [{libraryId, reachable, detail}]`. It re-probes when the config
  changes and on a slow interval.
- Liveness: WebSocket ping every 15 s; a node is `offline` after 45 s with no
  pong. `node.last_seen_at` becomes a real liveness stamp for remote nodes.

### Framing

Every frame is plain JSON. `protocol.ts` gains an envelope and node-level
messages; the existing `DaemonToAgent` / `AgentToDaemon` shapes are carried
unchanged inside it:

```ts
type NodeFrame =
  | { type: 'agent'; jobId: string; message: AgentToDaemon }
  | { type: 'hello'; ... }
  | { type: 'libraries'; ... }
  | { type: 'job-state'; jobId: string; state: 'running' | 'held-report' | 'lost' }
  | { type: 'log-backfill'; jobId: string; fromLine: number; lines: string[] };

type ServerFrame =
  | { type: 'agent'; jobId: string; message: DaemonToAgent }
  | { type: 'welcome'; ... } | { type: 'refused'; reason: string }
  | { type: 'config'; ... }
  | { type: 'abandon'; jobId: string; reason: string }
  | { type: 'ack-report'; jobId: string };
```

`AgentToDaemon` gains `{ type: 'commit-request'; id: number }` and
`DaemonToAgent` gains `{ type: 'commit-result'; id: number; granted: boolean;
reason?: string }`. Both travel inside the `agent` envelope like any other
agent message.

Jobs are addressed by `jobId`, not by a worker slot: the job id is what
survives a reconnect. Both parsers stay strict (drop what does not validate),
because the node's socket is the far end of third-party plugin code just as
the IPC channel is. `PROTOCOL_VERSION` is bumped to 2.

### Claiming

- Unchanged in kind: one atomic `UPDATE … RETURNING` in the daemon, now
  filtered by the target node's eligibility:
  - libraries the node reported reachable;
  - hardware the node declared;
  - that node's own worker target from its schedule;
  - tags.
- `job.node_id` is set on every job, local and remote.
- A node that is offline, paused, or has no reachable libraries is never
  claimed for.
- Payload build (`buildJobPayload`) happens at claim time in the daemon.
  Mapping and plugin hashes are applied to the built payload before it is
  sent; a later edit to the map does not affect a running job.

### Leases

A remote claim holds a **lease**, recorded on the job row (migration:
`job.lease_state`, `job.lease_expires_at`).

| `lease_state` | Meaning | Reclaimed when |
| --- | --- | --- |
| `connected` | Node is connected; renewed by its presence | Never by lease; the existing 24 h heartbeat floor still applies |
| `grace` | Node disconnected at `t`; `lease_expires_at = t + grace` | `lease_expires_at` passes |
| `committing` | A commit was granted; the node is installing | Never by lease; only the 24 h floor |
| `expired` | Grace passed; the attempt was stalled | — |

- Grace defaults to **1 hour** and is a server setting.
- On expiry the job closes as a stalled attempt through the normal
  `applyStall` backoff, and the file becomes claimable.
- Local jobs have no lease and keep today's pid fast path.

**Daemon restart.** Every remote job still `running` at startup enters
`grace` with `lease_expires_at = startup + grace`, so a daemon that was down
does not expire a node's leases the moment it comes back.

### The commit gate

This is the rule that keeps a reclaimed file from being written by two
workers.

Before a step that writes to the library, the node must hold a granted
commit:

- the first-party **Replace Original File** node;
- **any node `executor/vouchable.ts` cannot vouch for**, since a third-party
  node may write to the library itself.

Mechanism:

- `runPayload` gains a `commitGate: () => Promise<void>` port. `agent.ts`
  implements it as a `commit-request` round trip, identical on both kinds of
  node, so the gate is not a remote-only code path.
- A local `AgentHandle` grants every request. The in-process `trawlarr run`
  path passes a gate that resolves immediately.
- `RemoteAgentHandle` answers from the lease, as follows.
- The server grants only if the job's lease is `connected` or `committing` and
  the media file is still claimed by this job. It moves the lease to
  `committing` for the Replace node; for an unvouchable node the lease stays
  `connected`.
- While the node is disconnected the gate **waits**. It is never granted
  locally and never times out into a grant.
- A refusal (`granted: false`) throws a distinguished `Superseded` error. The
  run unwinds and removes its staging directory, the original file is
  untouched, and the agent reports the failure as superseded.
- The server applies it as a no-op on the file (it was already reclaimed) and
  closes the job row as `superseded`, a new job state (migration). No attempt
  is spent.

`committing` returns to `connected` when the step completes (the next `step`
message).

### Re-attach

The node keeps a journal in its data directory, one JSON file per job:
`{jobId, state, report?, logLines}`, written on every state change.

On `hello` the node lists every journaled job, and the server answers each:

| Node says | Server's row | Server does |
| --- | --- | --- |
| `running` | lease `grace`, still claimed | Lease → `connected`; the job continues |
| `running` | reclaimed / closed | `abandon` → node cancels the agent; the commit gate refuses if reached |
| `held-report` | still claimed | Applies the report, sends `ack-report`; node deletes the journal entry |
| `held-report` | reclaimed / closed | Records it on the job row as `superseded`; `ack-report` |
| `lost` (node restarted mid-job) | still claimed | `applyThrownFailure` path, as a vanished local child |

- A report is deleted from the journal only after `ack-report`, so a report
  never reaches the server zero times. Applying the same report twice is
  harmless, because `applyJobReport` is keyed by `jobId` and a closed job is
  not re-applied.
- `cancel` sent while a node is offline is kept on the job row and delivered
  on reconnect.

### Path mapping (Direct access)

- `node.path_map_json`: an ordered list of `{serverPath, nodePath}`, longest
  prefix wins. UI copy: *the server sees `/media/movies`* → *this node sees
  ___*.
- The server rewrites a payload before sending it:
  - `path`;
  - `library` roots;
  - staging and trash roots, which already derive from the library root, so
    they follow.
- It maps the returned report back (`ReplacedFile` paths, any path in step
  records it persists).
- An unmapped path is an ineligible library, not a failed job, so claiming
  never produces a job that cannot start.
- `configVars.config.nodeType` becomes `mapped` for Direct access, `unmapped`
  for File transfer. This is the only place that vocabulary appears.

### Plugin shipping

- The payload's `pluginPaths: Record<id, path>` gains
  `pluginHashes: Record<id, sha256>` for every plugin the daemon resolved.
- `GET /api/v1/nodes/plugins/:sha256` (node-secret auth) serves the plugin's
  directory as a tar stream.
- The node caches plugins content-addressed under `<data>/plugins/<sha>/` and
  rewrites `pluginPaths` to the cached copies before forking the agent.
- A hash mismatch after download is a failed download, never a run.
- The cache is pruned by LRU at a size cap.

### Job logs

- The agent on a node writes its log to the node's local journal copy, as it
  does today to `logPath`.
- The node host streams `log` frames, which the server appends to the job's
  normal log file, so a connected remote job's log looks like a local one.
- On reconnect the node sends `log-backfill` from the line the server last
  acknowledged. The journal keeps a bounded tail, capped the same as local job
  logs.
- As everywhere else, no durable decision reads the log.

### Plugin document store

`doc-request` / `doc-result` round trips are relayed unchanged. While the node
is disconnected they wait; they fail if the job's lease expires.

### Stall reaper

- The pid fast path requires `job.node_id = 'local'` (instead of
  `worker_host = hostname()`). Two machines can share a hostname, and in
  containers they often do; a hostname match must never let this host's pid
  table judge another machine's worker.
- Remote jobs are reclaimed by lease expiry (above).
- The 24 h heartbeat floor applies to every job regardless.

### Cancellation

- UI cancel on a remote job sends `cancel` inside the `agent` envelope, or
  queues it if the node is offline.
- The node host kills the agent's process group, ffmpeg included.
- The node settles with the same `AgentFailure` semantics a local handle
  produces, so `applyJobCancelled` is unchanged.

## Enrollment and node configuration

- **Add node** (Nodes page) → name → the server creates a `node` row and a
  one-time enrollment token, valid 24 h, stored hashed. The dialog shows the
  token once, together with both:
  - `docker run … -e TRAWLARR_MODE=node -e TRAWLARR_SERVER=… -e TRAWLARR_NODE_TOKEN=… ghcr.io/rgregg/trawlarr:<version>`
  - `trawlarr node --server … --token …`
- **Exchange**: `POST /api/v1/nodes/enroll {token}` → `{nodeId, secret}`. The
  token is consumed; the server stores `argon2(secret)`. The node writes the
  secret to `<data>/node.json` (mode 0600) and ignores the token afterwards.
- **Revoke** deletes the secret hash and closes the socket. The node's jobs
  enter `grace` and expire normally. The node cannot reconnect, and the Nodes
  page shows it as revoked until it is deleted.
- **Migration** adds to `node`: `secret_hash`, `enroll_token_hash`,
  `enroll_expires_at`, `revoked_at`, `worker_config_json` (counts per class and
  schedule windows, the existing schedule model), `paused`, `build_version`,
  `ffmpeg_json`, `libraries_json` (last probe results).
- **Nodes page**, per node:
  - online / offline / revoked, last seen, build version;
  - running jobs with progress;
  - worker counts and schedule, pause;
  - the path map editor;
  - each library's reachability, with the reason when unreachable
    ("`/media/shows` → `/mnt/shows`: not found");
  - hardware.

  Copy stays terse.
- **Docker**: the same image. `entrypoint.sh` runs `trawlarr node` when
  `TRAWLARR_MODE=node`. Add `docker/compose.node.yml` with an NVIDIA variant
  alongside `compose.nvidia.yml`. A node needs no database, no web UI, and no
  published port.
- The node's data directory holds `node.json`, the plugin cache, and the job
  journal. It takes the same kernel file lock the daemon uses, so two node
  processes cannot share one.

## Phase 2: File transfer

Designed now so phase 1 does not block it; not built in phase 1.

- `access_mode = 'transfer'`.
- Before forking the agent, the node downloads the input with
  `GET /api/v1/nodes/jobs/:jobId/input` into its local staging, and the
  payload's `path` points there.
- Replace Original File on a transfer node:
  - still runs its size and verification checks locally against the staged
    output;
  - instead of renaming, uploads the output
    (`PUT /api/v1/nodes/jobs/:jobId/output`);
  - then requests commit.
- The server installs the output with the same same-filesystem staging, trash
  and identity rules the local Replace node applies, factored out of the node
  so both share one implementation.
- Unvouchable third-party nodes that expect the library on disk see only the
  staged copy. This is documented; there is no general remedy, which is why
  Direct access is the recommended mode.
- Companion files (spec §4.2) are renamed by the server-side install.

## Error handling summary

| Situation | Result |
| --- | --- |
| Protocol version mismatch | `refused`, both versions named; node retries slowly |
| Node offline mid-job | Lease `grace`; job continues on the node; no commit until reconnect |
| Grace expires | Attempt stalled with normal backoff; node gets `abandon` on return |
| Commit refused | Output discarded, original untouched, job `superseded`, no attempt spent |
| Node restarts mid-job | Journal says `lost`; attempt stalled as a vanished child |
| Daemon restarts | Remote jobs enter `grace` from startup; nodes reconnect with backoff |
| Library unreachable on node | Library ineligible for that node; reason shown |
| Plugin hash mismatch | Download retried; job fails with a named error if it persists |
| Revoked node | Socket closed; jobs expire through grace |

## Testing

- **Unit**
  - Envelope and node-frame parsers (strict: malformed frames dropped).
  - Path-map rewriting both ways, including longest prefix and unmapped
    paths.
  - Lease state transitions, including daemon-restart grace.
  - Reaper fast path refuses non-local `node_id` even with a matching
    hostname.
  - Enrollment token single use and expiry; argon2 secret check.
  - Journal: report deleted only after ack.
- **End-to-end** (`packages/server/test/`): a real daemon and a real
  `trawlarr node` process over loopback. The node sees the library through a
  second path (a symlinked or bind directory) with a path map. Cases:
  1. normal completion; the file is replaced through mapped paths;
  2. socket severed mid-job → reconnect → completes;
  3. severed past grace → another claim → original node reaches Replace →
     refused → original file byte-identical, staging removed;
  4. node killed and restarted with a held report → report applied once;
  5. revoke mid-job;
  6. protocol version mismatch refused;
  7. cancel while offline, delivered on reconnect;
  8. plugin fetched by hash and cached; second job does not re-download.
- Real-ffmpeg cases gate on `test-support/tool-availability.ts` as usual;
  media is generated with `lavfi testsrc`.
- Docker contract tests cover `TRAWLARR_MODE=node` and `compose.node.yml`.

## Out of scope

- TLS termination (reverse proxy, as for the UI today; the enrollment dialog
  shows `wss://` when the server is behind one).
- Nodes connecting to more than one server.
- Scheduling beyond per-node counts, tags, hardware and reachability (e.g.
  data locality scoring).
- Extracting `@trawlarr/node-agent` as its own package.
