export * from './db/connection.js';
export * from './db/migrate.js';
export * from './db/chunked.js';
export * from './db/media-file-repo.js';
export * from './db/library-repo.js';
export * from './db/plugin-document-repo.js';
export * from './db/flow-repo.js';
export * from './db/job-repo.js';
export * from './db/settings-repo.js';
// The installed-plugin surface, exported for the same reason the repositories
// above are: it is now consumed OUTSIDE this package (the CLI's plugin
// commands, and any caller that needs to resolve an installed id), and an
// inconsistent barrel is how a later caller ends up deep-importing a dist
// path. `plugins/registry.js` is the seam every resolution site goes through.
export * from './plugins/plugin-id.js';
export * from './plugins/plugin-repo.js';
export * from './plugins/registry.js';
export * from './plugins/fetch-source.js';
export * from './plugins/sync-source.js';
export * from './fs/partial-hash.js';
export * from './fs/path-contains.js';
export * from './fs/walk.js';
export * from './fs/companions.js';
export * from './library/paths.js';
export * from './library/replace-seams.js';
export * from './probe/ffprobe.js';
export * from './scanner/scan-library.js';
export * from './worker/job-payload.js';
export * from './worker/run-payload.js';
export * from './worker/apply-report.js';
export * from './worker/run-job.js';
// The agent ENTRY POINT (`worker/agent.js`) is deliberately absent: importing
// it starts a message pump. Only its protocol and the daemon's handle for it
// belong in the barrel.
export * from './worker/protocol.js';
export * from './worker/agent-handle.js';
export * from './worker/loop.js';
export * from './daemon/events.js';
export * from './daemon/library-health.js';
export * from './daemon/supervisor.js';
export * from './daemon/watcher.js';
export * from './daemon/scan-coordinator.js';
export * from './daemon/lockfile.js';
export * from './daemon/daemon.js';
export * from './library/pause-explanation.js';
export * from './library/trash-sweep.js';
export * from './flow/dry-run.js';
export * from './api/router.js';
export * from './api/auth.js';
export * from './api/server.js';
export * from './api/ws.js';
export * from './api/routes/nodes.js';
// The CLI's own entry point (`cli.js`) stays out of the barrel for the same
// reason `worker/agent.js` does: importing it runs a command. Its HTTP client
// is a library, and belongs here.
export * from './cli-client.js';
