import { execFile } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeSignature, extractFacts, type FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { scanLibrary } from './scan-library.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const definition: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'hevc' },
    },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
};

const makeMedia = async (path: string): Promise<void> => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=64x48:rate=5',
    '-c:v',
    'libx264',
    path,
  ]);
};

let root: string;
let db: Db;
let libraryId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'trawlarr-scan-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  await makeMedia(join(root, 'one.mkv'));
  await makeMedia(join(root, 'sub', 'two.mkv'));
  writeFileSync(join(root, 'ignore.txt'), 'not media');
}, 120_000);

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  const flow = createFlowRepo(db).create({ name: 'HEVC', definition, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });
  libraryId = library.id;
});

const scan = () => scanLibrary({ db, libraryId, ffprobePath: 'ffprobe', nowMs: now });

/**
 * The signature a successful run against `flowDefinitionHash` would have
 * stamped for `row`, computed the same way the scanner does: facts
 * extracted directly from the stored probe together with the row's own
 * container/size, never read back out of `getProbe` (see its doc comment —
 * its recomputed facts track the row's CURRENT container/size, not the ones
 * a specific run actually converged against).
 */
const convergedSignature = (row: MediaFileRow, flowDefinitionHash: string): string => {
  const probeInfo = createMediaFileRepo(db).getProbe(row.id);
  if (probeInfo === null) throw new Error(`No probe stored for ${row.id}`);
  const facts = extractFacts({
    probe: probeInfo.probe,
    container: row.container,
    sizeBytes: row.size_bytes,
  });
  return computeSignature({ flowDefinitionHash, facts });
};

describe('scanLibrary', () => {
  it('finds media, ignores non-media, and queues what is not yet converged', async () => {
    const summary = await scan();
    expect(summary.seen).toBe(2);
    expect(summary.added).toBe(2);
    expect(summary.queued).toBe(2);
    // Both are new, so both must have gone through an actual probe — proves
    // `probed` counts something real rather than sitting at zero.
    expect(summary.probed).toBe(2);
    expect(createMediaFileRepo(db).listByLibrary({ libraryId, state: 'queued' })).toHaveLength(2);
  });

  it('stores the probe and the denormalised codec', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const [file] = repo.listByLibrary({ libraryId });
    expect(repo.getProbe(file!.id)?.probe.streams?.[0]?.codec_name).toBe('h264');
  });

  it('is idempotent: a second scan adds nothing and re-probes nothing', async () => {
    await scan();
    const second = await scan();
    expect(second.added).toBe(0);
    expect(second.seen).toBe(2);
    // The counter that actually distinguishes "skipped the probe" from
    // "probed again and happened to get the same answer".
    expect(second.probed).toBe(0);
    expect(createMediaFileRepo(db).listByLibrary({ libraryId })).toHaveLength(2);
  });

  it('re-probes only the file that changed on a rescan, not the whole library', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const before = repo
      .listByLibrary({ libraryId })
      .map((r) => r.id)
      .sort();
    const changedPath = join(root, 'one.mkv');
    const future = new Date(Date.now() + 60_000);
    utimesSync(changedPath, future, future);
    const summary = await scan();
    expect(summary.seen).toBe(2);
    expect(summary.probed).toBe(1);
    // A changed file must still be the SAME record, re-probed — not a
    // "changed" file misclassified as new (which would also leave probed
    // at 1, but would mean rule 5 is silently broken).
    expect(summary.added).toBe(0);
    const after = repo
      .listByLibrary({ libraryId })
      .map((r) => r.id)
      .sort();
    expect(after).toEqual(before);
  });

  it('leaves a converged file alone', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const flowDefinitionHash = createFlowRepo(db).getByName('HEVC')!.definitionHash;
    const files = repo.listByLibrary({ libraryId });
    // Mark both good with the signature they actually converged against,
    // exactly as applyRunOutcome would on a successful run.
    for (const file of files) {
      const ledger = repo.getLedger(file.id)!;
      const signature = convergedSignature(file, flowDefinitionHash);
      repo.setLedger({ fileId: file.id, record: { ...ledger, state: 'good', signature } });
    }
    const summary = await scan();
    expect(summary.alreadyGood).toBe(2);
    expect(summary.queued).toBe(0);
  });

  it('re-queues a converged file after the flow changes', async () => {
    // The step the whole convergence design depends on.
    await scan();
    const repo = createMediaFileRepo(db);
    const flowDefinitionHash = createFlowRepo(db).getByName('HEVC')!.definitionHash;
    for (const file of repo.listByLibrary({ libraryId })) {
      const ledger = repo.getLedger(file.id)!;
      const signature = convergedSignature(file, flowDefinitionHash);
      repo.setLedger({ fileId: file.id, record: { ...ledger, state: 'good', signature } });
    }
    createFlowRepo(db).update({
      id: createFlowRepo(db).getByName('HEVC')!.id,
      definition: {
        ...definition,
        nodes: definition.nodes.map((n) =>
          n.id === 'check' ? { ...n, inputs: { codec: 'av1' } } : n,
        ),
      },
      nowMs: NOW + 1,
    });
    const summary = await scan();
    expect(summary.queued).toBe(2);
    expect(summary.alreadyGood).toBe(0);
  });

  it('keeps the same record when a file is renamed', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const before = repo
      .listByLibrary({ libraryId })
      .map((r) => r.id)
      .sort();
    renameSync(join(root, 'one.mkv'), join(root, 'one-renamed.mkv'));
    try {
      await scan();
      const after = repo
        .listByLibrary({ libraryId })
        .map((r) => r.id)
        .sort();
      expect(after).toEqual(before);
    } finally {
      renameSync(join(root, 'one-renamed.mkv'), join(root, 'one.mkv'));
    }
  });

  it('skips a hardlinked file unless the library allows it', async () => {
    const linked = join(root, 'sub', 'linked.mkv');
    linkSync(join(root, 'one.mkv'), linked);
    try {
      const summary = await scan();
      expect(summary.skippedHardlinked).toBeGreaterThan(0);
    } finally {
      execFileAsync('rm', ['-f', linked]);
    }
  });

  it('does not retry a terminal file', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const [file] = repo.listByLibrary({ libraryId });
    const ledger = repo.getLedger(file!.id)!;
    repo.setLedger({ fileId: file!.id, record: { ...ledger, state: 'not_converging' } });
    await scan();
    expect(repo.getLedger(file!.id)?.state).toBe('not_converging');
  });

  it('reports rather than queues when the library has no flow', async () => {
    createLibraryRepo(db).setFlow(libraryId, null);
    const summary = await scan();
    expect(summary.seen).toBe(2);
    expect(summary.queued).toBe(0);
  });

  it('counts an unreadable file without aborting the scan', async () => {
    writeFileSync(join(root, 'broken.mkv'), 'this is not media');
    try {
      const summary = await scan();
      expect(summary.unreadable).toBe(1);
      expect(summary.seen).toBe(3);
      // probeFile was still invoked for the broken file (it's readable and
      // hashable, just not decodable) alongside the two real ones — the
      // increment sits before the call specifically so a ProbeError still
      // counts. If that ordering were ever inverted, this assertion would
      // catch the resulting undercount.
      expect(summary.probed).toBe(3);
    } finally {
      execFileAsync('rm', ['-f', join(root, 'broken.mkv')]);
    }
  });

  it('re-probes a file whose probe has never succeeded, instead of leaving it unknown forever', async () => {
    // A first probe that fails leaves no probe_json, so the file can never
    // compute a signature and never leaves `unknown` — permanently capping
    // the library's convergence percentage. Nothing about the FILE changes
    // when the failure was transient (a busy ffprobe, a mount that blinked,
    // a truncated download later replaced at the same size), so a
    // size/mtime-only probe rule never looks at it again.
    const brokenPath = join(root, 'never-probed.mkv');
    writeFileSync(brokenPath, 'this is not media');
    try {
      const first = await scan();
      expect(first.probed).toBe(3);
      expect(first.unreadable).toBe(1);

      const repo = createMediaFileRepo(db);
      const brokenRow = repo.listByLibrary({ libraryId }).find((r) => r.path === brokenPath);
      expect(brokenRow?.probe_json).toBeNull();
      expect(brokenRow?.state).toBe('unknown');

      // Untouched on disk — same size, same mtime — and still re-probed.
      const second = await scan();
      expect(second.probed).toBe(1);
      expect(second.unreadable).toBe(1);
      // The two healthy files are still skipped: this is a targeted retry,
      // not a reversion to probing everything on every scan.
      expect(second.seen).toBe(3);
    } finally {
      unlinkSync(brokenPath);
    }
  });
});

describe('scanLibrary excludes reserved staging/trash directories', () => {
  it('does not admit files under the default .trawlarr staging or trash directories', async () => {
    const libRoot = mkdtempSync(join(tmpdir(), 'trawlarr-scan-reserved-'));
    mkdirSync(join(libRoot, '.trawlarr', 'trash'), { recursive: true });
    mkdirSync(join(libRoot, '.trawlarr', 'staging'), { recursive: true });
    await makeMedia(join(libRoot, 'keep.mkv'));
    await makeMedia(join(libRoot, '.trawlarr', 'trash', 'deleted.mkv'));
    await makeMedia(join(libRoot, '.trawlarr', 'staging', 'inprogress.mkv'));

    const flow = createFlowRepo(db).create({ name: 'HEVC-reserved', definition, nowMs: NOW });
    const library = createLibraryRepo(db).create({
      name: 'MoviesReserved',
      roots: [libRoot],
      extensions: ['mkv'],
      flowId: flow.id,
      nowMs: NOW,
    });

    const summary = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(summary.added).toBe(1);
    const rows = createMediaFileRepo(db).listByLibrary({ libraryId: library.id });
    expect(rows.map((r) => r.path)).toEqual([join(libRoot, 'keep.mkv')]);
  }, 60_000);

  it('does not break when the configured staging directory sits outside every root', async () => {
    const libRoot = mkdtempSync(join(tmpdir(), 'trawlarr-scan-reserved-'));
    const outsideStaging = mkdtempSync(join(tmpdir(), 'trawlarr-scan-staging-'));
    await makeMedia(join(libRoot, 'keep.mkv'));
    await makeMedia(join(outsideStaging, 'not-in-library.mkv'));

    const flow = createFlowRepo(db).create({ name: 'HEVC-outside', definition, nowMs: NOW });
    const library = createLibraryRepo(db).create({
      name: 'MoviesOutsideStaging',
      roots: [libRoot],
      extensions: ['mkv'],
      stagingDir: outsideStaging,
      flowId: flow.id,
      nowMs: NOW,
    });

    const summary = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(summary.added).toBe(1);
    const rows = createMediaFileRepo(db).listByLibrary({ libraryId: library.id });
    expect(rows.map((r) => r.path)).toEqual([join(libRoot, 'keep.mkv')]);
  }, 60_000);

  it('does not prune a sibling directory that merely shares ".trawlarr" as a string prefix', async () => {
    // The prefix-vs-segment trap: "/root/.trawlarr-old" starts with the
    // string "/root/.trawlarr" without being inside it.
    const libRoot = mkdtempSync(join(tmpdir(), 'trawlarr-scan-reserved-'));
    mkdirSync(join(libRoot, '.trawlarr-old'), { recursive: true });
    await makeMedia(join(libRoot, 'keep.mkv'));
    await makeMedia(join(libRoot, '.trawlarr-old', 'legacy.mkv'));

    const flow = createFlowRepo(db).create({ name: 'HEVC-oldsuffix', definition, nowMs: NOW });
    const library = createLibraryRepo(db).create({
      name: 'MoviesOldSuffix',
      roots: [libRoot],
      extensions: ['mkv'],
      flowId: flow.id,
      nowMs: NOW,
    });

    const summary = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(summary.added).toBe(2);
  }, 60_000);

  it(
    'excludes a configured staging directory reached through a symlink alias of the root ' +
      '(the "/media -> /mnt/media" Docker shape)',
    async () => {
      const realRoot = mkdtempSync(join(tmpdir(), 'trawlarr-scan-real-'));
      const aliasParent = mkdtempSync(join(tmpdir(), 'trawlarr-scan-aliasparent-'));
      const alias = join(aliasParent, 'media');
      symlinkSync(realRoot, alias, 'dir');

      mkdirSync(join(realRoot, 'staging'), { recursive: true });
      await makeMedia(join(realRoot, 'keep.mkv'));
      await makeMedia(join(realRoot, 'staging', 'half-written.mkv'));

      const flow = createFlowRepo(db).create({ name: 'HEVC-alias', definition, nowMs: NOW });
      const library = createLibraryRepo(db).create({
        name: 'MoviesAliasedStaging',
        // The library's root is the REAL path...
        roots: [realRoot],
        extensions: ['mkv'],
        // ...but staging is configured through the symlinked alias, exactly
        // the shape a Docker media stack produces ("/media" mounted, backed
        // by "/mnt/media" underneath, or vice versa).
        stagingDir: join(alias, 'staging'),
        flowId: flow.id,
        nowMs: NOW,
      });

      const summary = await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: 'ffprobe',
        nowMs: now,
      });
      expect(summary.added).toBe(1);
      const rows = createMediaFileRepo(db).listByLibrary({ libraryId: library.id });
      expect(rows.map((r) => r.path)).toEqual([join(realRoot, 'keep.mkv')]);
    },
    60_000,
  );
});

/**
 * Probing is the expensive part of a scan, and spec §4.1 requires it to be
 * RESUMABLE: "a scan interrupted at 60,000 of 100,000 files does not restart
 * from zero". It only resumes if each probe is on disk by the time the
 * process dies — a result held in memory until the walk finishes is lost to
 * a deploy, a crash or an OOM kill, and the daemon restarts far more often
 * than a one-shot CLI did.
 *
 * These use a stub ffprobe that LOGS every invocation, so the count of real
 * probes is evidence independent of the summary's own counter, and fake
 * `.mkv` files, since nothing here decodes anything.
 */
describe('scanLibrary: an interrupted scan resumes rather than restarting', () => {
  const FILE_COUNT = 5;
  const INTERRUPT_AT = 3; // Throw as the third file is reached: two are done.

  class Interrupted extends Error {}

  let resumeRoot: string;
  let probeLog: string;
  let stubFfprobe: string;
  let resumeLibraryId: string;

  const probedPaths = (): string[] => {
    try {
      return readFileSync(probeLog, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  const rows = (): MediaFileRow[] =>
    createMediaFileRepo(db).listByLibrary({ libraryId: resumeLibraryId });

  const probedRowCount = (): number => rows().filter((row) => row.probe_json !== null).length;

  const resumeScan = (onProgress?: (seen: number) => void) =>
    scanLibrary({
      db,
      libraryId: resumeLibraryId,
      ffprobePath: stubFfprobe,
      nowMs: now,
      onProgress,
    });

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'trawlarr-resume-'));
    resumeRoot = join(base, 'media');
    mkdirSync(resumeRoot, { recursive: true });
    for (let i = 0; i < FILE_COUNT; i += 1) {
      writeFileSync(join(resumeRoot, `file-${i}.mkv`), `contents of file ${i}`);
    }

    probeLog = join(base, 'probed.log');
    stubFfprobe = join(base, 'ffprobe.sh');
    writeFileSync(
      stubFfprobe,
      [
        '#!/bin/sh',
        'for arg in "$@"; do last=$arg; done',
        `printf '%s\\n' "$last" >> ${JSON.stringify(probeLog)}`,
        `printf '%s' '{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080}],"format":{"duration":"60.0","size":"4096","bit_rate":"16384"}}'`,
        '',
      ].join('\n'),
    );
    chmodSync(stubFfprobe, 0o755);

    const flow = createFlowRepo(db).create({ name: 'HEVC-resume', definition, nowMs: NOW });
    resumeLibraryId = createLibraryRepo(db).create({
      name: 'Resumable',
      roots: [resumeRoot],
      extensions: ['mkv'],
      flowId: flow.id,
      nowMs: NOW,
    }).id;
  });

  it('keeps the probes a killed scan already did, and re-probes only what it never reached', async () => {
    let probedWhenInterrupted = -1;
    await expect(
      resumeScan((seen) => {
        if (seen !== INTERRUPT_AT) return;
        // Read the DATABASE from inside the walk: the two finished files
        // must already be durable here, not merely queued up in memory for
        // a phase that this interruption is about to prevent.
        probedWhenInterrupted = probedRowCount();
        throw new Interrupted('killed mid-walk');
      }),
    ).rejects.toBeInstanceOf(Interrupted);

    expect(probedWhenInterrupted).toBe(INTERRUPT_AT - 1);
    expect(probedPaths()).toHaveLength(INTERRUPT_AT - 1);
    expect(probedRowCount()).toBe(INTERRUPT_AT - 1);

    // The resuming scan pays only for the files the interrupted one never
    // reached — the whole property: 5 files, 2 already done, 3 to do.
    const resumed = await resumeScan();
    expect(resumed.seen).toBe(FILE_COUNT);
    expect(resumed.probed).toBe(FILE_COUNT - (INTERRUPT_AT - 1));
    // Every file probed exactly once across BOTH scans.
    expect(probedPaths()).toHaveLength(FILE_COUNT);
    expect(new Set(probedPaths()).size).toBe(FILE_COUNT);
    expect(probedRowCount()).toBe(FILE_COUNT);

    // And a settled library costs nothing at all.
    const settled = await resumeScan();
    expect(settled.seen).toBe(FILE_COUNT);
    expect(settled.probed).toBe(0);
    expect(probedPaths()).toHaveLength(FILE_COUNT);
  });

  it('reconciles nothing when the walk is interrupted, however stale the rows it never reached', async () => {
    // The sharpest risk in making a scan incremental: reconciliation seeing
    // a PARTIAL picture. Every row's recorded path is made stale by a
    // rename, so a reconciliation run before the walk reaches the new paths
    // would find ENOENT on each one and mark live files missing.
    await resumeScan();
    expect(rows()).toHaveLength(FILE_COUNT);
    for (let i = 0; i < FILE_COUNT; i += 1) {
      renameSync(join(resumeRoot, `file-${i}.mkv`), join(resumeRoot, `renamed-${i}.mkv`));
    }

    await expect(
      resumeScan((seen) => {
        if (seen === INTERRUPT_AT) throw new Interrupted('killed mid-walk');
      }),
    ).rejects.toBeInstanceOf(Interrupted);

    // Not one row marked missing, including the ones whose path still
    // points at a file that no longer exists there.
    expect(rows().filter((row) => row.missing_since_ms !== null)).toHaveLength(0);

    // Reconciliation happens once the walk is complete, and with the whole
    // picture it correctly finds nothing missing: the files were renamed,
    // not deleted, and the rows followed them.
    const complete = await resumeScan();
    expect(complete.missing).toBe(0);
    expect(complete.seen).toBe(FILE_COUNT);
    const after = rows();
    expect(after).toHaveLength(FILE_COUNT);
    expect(after.filter((row) => row.missing_since_ms !== null)).toHaveLength(0);
    expect(after.map((row) => row.path).sort()).toEqual(
      Array.from({ length: FILE_COUNT }, (_, i) => join(resumeRoot, `renamed-${i}.mkv`)).sort(),
    );
  });

  it('still marks a genuinely deleted file missing when the walk completes', async () => {
    // The counterpart: incremental commits must not make reconciliation
    // toothless. The scanner is the only thing that moves a file out of
    // `good`, so a scan that stops reconciling is a silent failure.
    await resumeScan();
    unlinkSync(join(resumeRoot, 'file-0.mkv'));
    const summary = await resumeScan();
    expect(summary.seen).toBe(FILE_COUNT - 1);
    expect(summary.missing).toBe(1);
    const gone = rows().find((row) => row.path === join(resumeRoot, 'file-0.mkv'));
    expect(gone?.missing_since_ms).not.toBeNull();
  });
});
