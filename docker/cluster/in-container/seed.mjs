// Runs INSIDE the server image, before the daemon first starts, against the
// same /config volume the daemon will open. Usage:
//   node /cluster/seed.mjs <leaseGraceMs> <localTranscodeWorkers>
//
// `nodes.leaseGraceMs` cannot be set through the API, and the watcher and
// periodic rescan would race the scenarios, so all three are written here.
// The short grace is accepted only because compose.cluster.yml sets
// NODE_ENV=test and TRAWLARR_TEST_ALLOW_SHORT_GRACE=1.
import { openDatabase } from '/app/dist/db/connection.js';
import { migrate } from '/app/dist/db/migrate.js';
import { createSettingsRepo } from '/app/dist/db/settings-repo.js';

const leaseGraceMs = Number(process.argv[2]);
const localTranscode = Number(process.argv[3]);
if (!Number.isInteger(leaseGraceMs) || !Number.isInteger(localTranscode)) {
  throw new Error('usage: seed.mjs <leaseGraceMs> <localTranscodeWorkers>');
}

const db = openDatabase({ file: '/config/trawlarr.db' });
migrate(db);
const settings = createSettingsRepo({ db });
settings.setScan({ watchEnabled: false, rescanIntervalMs: 0, settleMs: 0 });
settings.setSchedule({
  timezone: 'UTC',
  baseCounts: { transcode: localTranscode, health: 0 },
  windows: [],
});
settings.setNodes({ leaseGraceMs });
db.close();
