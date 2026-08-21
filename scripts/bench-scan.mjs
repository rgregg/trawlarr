#!/usr/bin/env node
/**
 * Scan benchmark: build a synthetic library of N files, scan it cold, then
 * scan it again warm, and report the numbers spec §3.3 and §4.1 are about.
 *
 * NOT PART OF THE GATE. It builds 100,000 inodes and takes minutes, and its
 * output is a measurement a human reads rather than an assertion — the
 * suite's job is the structural properties
 * (`packages/server/test/scan-bounded.test.ts`), which is why this can
 * afford to be slow and honest. A benchmark that failed CI on a slow machine
 * would be worse than no benchmark; a benchmark whose properties were
 * unasserted would be theatre. This repo has both halves.
 *
 *   pnpm bench:scan --files 100000 --data-dir /var/tmp/trawlarr-bench
 *
 * Options:
 *   --files <n>       how many files to create (default 100000)
 *   --data-dir <path> where they go (default a fresh dir under $TMPDIR)
 *   --keep            do not delete the tree afterwards
 *   --yes             skip the "this is the disk I am about to fill" pause
 *   --probe-concurrency <n>  probes in flight at once (default: the
 *                     scanner's own default). 1 is the serial behaviour, so
 *                     "--probe-concurrency 1" is how the before/after of
 *                     bounded-concurrency probing is measured on one build.
 *   --probe-latency-ms <n>  make the fake probe WAIT this long before
 *                     answering (default 0). A local fake probe is pure
 *                     spawn cost; a probe over NFS is mostly waiting, and
 *                     waiting is what concurrency is for — so this is how a
 *                     network mount is approximated without one.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    files: { type: 'string', default: '100000' },
    'data-dir': { type: 'string' },
    keep: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'probe-concurrency': { type: 'string' },
    'probe-latency-ms': { type: 'string', default: '0' },
  },
});

const fileCount = Number(values.files);
if (!Number.isInteger(fileCount) || fileCount < 1) {
  console.error(`--files must be a positive integer, got ${String(values.files)}`);
  process.exit(2);
}

const probeConcurrency =
  values['probe-concurrency'] === undefined ? undefined : Number(values['probe-concurrency']);
if (
  probeConcurrency !== undefined &&
  (!Number.isInteger(probeConcurrency) || probeConcurrency < 1)
) {
  console.error(
    `--probe-concurrency must be a positive integer, got ${String(values['probe-concurrency'])}`,
  );
  process.exit(2);
}

const probeLatencyMs = Number(values['probe-latency-ms']);
if (!Number.isInteger(probeLatencyMs) || probeLatencyMs < 0) {
  console.error(
    `--probe-latency-ms must be a whole number of 0 or more, got ` +
      `${String(values['probe-latency-ms'])}`,
  );
  process.exit(2);
}

const dataDir = values['data-dir'] ?? join(tmpdir(), `trawlarr-bench-${String(Date.now())}`);
const root = join(dataDir, 'library');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'packages/server/dist');
const srcDir = join(repoRoot, 'packages/server/src');

/** Newest mtime under `dir`, recursively. */
const newestMtimeMs = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
};

// The BUILT artifact, deliberately: a benchmark of src/ through a loader is
// not what ships. If dist is stale the number is wrong, so say so loudly
// rather than quietly measure code nobody will run.
try {
  const built = newestMtimeMs(distDir);
  const source = newestMtimeMs(srcDir);
  if (built < source) {
    console.error(
      `packages/server/dist is OLDER than packages/server/src — this benchmark would measure ` +
        `stale compiled output. Run "pnpm build" (or "tsc --build --force") first.`,
    );
    process.exit(2);
  }
} catch (error) {
  console.error(
    `Could not compare packages/server/dist against src (${String(error)}). ` +
      `Run "pnpm build" first.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Say what disk this is about to use, BEFORE using it. 100,000 files is
// 100,000 inodes; on a small tmpfs (which is what $TMPDIR often is) that is
// enough to fill the filesystem out from under whatever else is running.
// ---------------------------------------------------------------------------
mkdirSync(root, { recursive: true });
const fs = statfsSync(dataDir);
const freeBytes = fs.bavail * fs.bsize;
// One tiny file still costs a full block, plus its directory entry.
const estimatedBytes = fileCount * fs.bsize + 64 * 1024 * 1024;
console.log(
  [
    `trawlarr scan benchmark`,
    `  files          ${String(fileCount)}`,
    `  probe concurrency ${probeConcurrency === undefined ? "the scanner's default" : String(probeConcurrency)}`,
    `  probe latency  ${String(probeLatencyMs)} ms`,
    `  data dir       ${dataDir}`,
    `  block size     ${String(fs.bsize)} bytes`,
    `  free on that filesystem  ${(freeBytes / 1024 ** 3).toFixed(1)} GiB`,
    `  this run will use roughly ${(estimatedBytes / 1024 ** 3).toFixed(2)} GiB and ` +
      `${String(fileCount)} inodes`,
    `  cleanup        ${values.keep ? 'NO (--keep): delete it yourself' : `yes, ${dataDir} is removed at the end`}`,
    '',
  ].join('\n'),
);

if (estimatedBytes > freeBytes) {
  console.error(
    `Refusing to start: this run needs about ` +
      `${(estimatedBytes / 1024 ** 3).toFixed(2)} GiB and ${dataDir} has ` +
      `${(freeBytes / 1024 ** 3).toFixed(2)} GiB free. Pass --data-dir somewhere larger, or a ` +
      `smaller --files.`,
  );
  if (!values.keep) rmSync(dataDir, { recursive: true, force: true });
  process.exit(2);
}

// A fake ffprobe. Real ffprobe at this scale benchmarks ffprobe, not the
// scanner — and the scanner is what spec §3.3 and §4.1 make promises about.
const probePath = join(dataDir, 'fake-ffprobe');
writeFileSync(
  probePath,
  `#!/bin/sh\n${probeLatencyMs === 0 ? '' : `sleep ${String(probeLatencyMs / 1000)}\n`}cat <<'JSON'\n${JSON.stringify(
    {
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
      ],
      format: { format_name: 'matroska,webm', duration: '120.0', size: '1024', bit_rate: '68' },
    },
  )}\nJSON\n`,
);
chmodSync(probePath, 0o755);

const seedStarted = performance.now();
for (let i = 0; i < fileCount; i += 1) {
  const dir = join(root, `d${String(Math.floor(i / 100))}`);
  if (i % 100 === 0) mkdirSync(dir, { recursive: true });
  // Distinct contents: identity is content-keyed, and 100,000 byte-identical
  // files would all collide onto one row and measure nothing.
  writeFileSync(join(dir, `f${String(i)}.mkv`), `trawlarr bench file ${String(i)}`);
}
console.log(
  `seeded ${String(fileCount)} files in ${Math.round(performance.now() - seedStarted)} ms\n`,
);

const { openDatabase } = await import('../packages/server/dist/db/connection.js');
const { migrate } = await import('../packages/server/dist/db/migrate.js');
const { createLibraryRepo } = await import('../packages/server/dist/db/library-repo.js');
const { scanLibrary } = await import('../packages/server/dist/scanner/scan-library.js');

const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
migrate(db);
const library = createLibraryRepo(db).create({ name: 'Bench', roots: [root], nowMs: Date.now() });

console.log(
  `machine: ${String(cpus().length)} x ${cpus()[0]?.model ?? 'unknown'}, ` +
    `${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM, node ${process.version}\n`,
);

const pass = async (label) => {
  const durations = [];
  const gaps = [];
  let peakRss = process.memoryUsage().rss;
  let last = performance.now();
  const started = performance.now();
  const summary = await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: probePath,
    probeConcurrency,
    nowMs: () => Date.now(),
    // `elapsedMs` is the transaction's own blocking span. The gap between
    // commits is tracked separately: it is the interesting number for
    // throughput, but it is NOT what freezes the API, and reporting it as
    // "maxTransactionMs" would blame sqlite for an ffprobe spawn.
    onTransactionCommitted: (_rows, elapsedMs) => {
      const now = performance.now();
      durations.push(elapsedMs);
      gaps.push(now - last);
      last = now;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    },
  });
  const wallMs = performance.now() - started;
  const sorted = [...durations].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        pass: label,
        probeConcurrency: probeConcurrency ?? 'default',
        probeLatencyMs,
        files: summary.seen,
        probed: summary.probed,
        wallMs: Math.round(wallMs),
        filesPerSecond: Math.round(summary.seen / (wallMs / 1000)),
        transactions: durations.length,
        maxTransactionMs: Number(Math.max(0, ...durations).toFixed(1)),
        p99TransactionMs: Number((sorted[Math.floor(sorted.length * 0.99)] ?? 0).toFixed(1)),
        maxGapBetweenTransactionsMs: Number(Math.max(0, ...gaps).toFixed(1)),
        peakRssMB: Math.round(peakRss / 1024 / 1024),
      },
      null,
      2,
    ),
  );
};

await pass('cold');
await pass('warm');

db.close();
if (!values.keep) rmSync(dataDir, { recursive: true, force: true });
else console.log(`\n--keep: ${dataDir} left in place. Delete it when you are done.`);
