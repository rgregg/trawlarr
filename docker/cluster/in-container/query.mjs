// Runs INSIDE the server container. Read-only SQL against the daemon's
// database; rows as JSON on stdout. Usage:
//   node /cluster/query.mjs "<sql>" '<json array of parameters>'
import { createRequire } from 'node:module';

const require = createRequire('/app/');
const Database = require('better-sqlite3');

const db = new Database('/config/trawlarr.db', { readonly: true, fileMustExist: true });
const params = JSON.parse(process.argv[3] ?? '[]');
process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all(...params)));
db.close();
