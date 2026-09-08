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
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { ProbeError } from '../probe/ffprobe.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
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
  it('adopts externally replaced content at a held path without opening a claimable second row', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const held = repo.listByLibrary({ libraryId })[0]!;
    // Model the old identity being replaced externally: the actual media on
    // disk is different from both stored identity keys, at the same path.
    db.prepare('UPDATE media_file SET inode_key = ?, content_key = ? WHERE id = ?').run(
      'old-inode',
      'old-content',
      held.id,
    );
    for (const row of repo.listByLibrary({ libraryId })) {
      repo.setLedger({
        fileId: row.id,
        record: {
          ...repo.getLedger(row.id)!,
          state: 'held',
          reviewReason: 'Inspect before retry.',
        },
      });
    }
    const result = await scan();
    const rows = repo.listByLibrary({ libraryId });
    expect(result.added).toBe(0);
    expect(result.queued).toBe(0);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.path === held.path)).toHaveLength(1);
    expect(repo.getById(held.id)?.content_key).not.toBe('old-content');
    expect(repo.getById(held.id)?.video_codec).toBe('h264');
    expect(repo.getLedger(held.id)).toMatchObject({
      state: 'held',
      reviewReason: 'Inspect before retry.',
      attemptCount: 0,
      holdUntilMs: null,
    });
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: Number.MAX_SAFE_INTEGER })).toBeNull();
    repo.requeue(held.id);
    expect(repo.getById(held.id)?.review_path).toBeNull();
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })?.fileId).toBe(held.id);
  });

  it('recognizes a held replacement path even when its old path and identity were not reconciled', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const held = repo.listByLibrary({ libraryId })[0]!;
    repo.setLedger({
      fileId: held.id,
      record: { ...repo.getLedger(held.id)!, state: 'held', reviewReason: 'Probe unavailable.' },
    });
    repo.rememberReviewIntent({ fileId: held.id, reason: 'Probe unavailable.', path: held.path });
    db.prepare('UPDATE media_file SET path = ?, inode_key = ?, content_key = ? WHERE id = ?').run(
      `${held.path}.old`,
      'old-inode',
      'old-content',
      held.id,
    );
    const result = await scan();
    expect(result.added).toBe(0);
    expect(repo.listByLibrary({ libraryId })).toHaveLength(2);
    expect(repo.getById(held.id)).toMatchObject({
      path: held.path,
      state: 'held',
      review_reason: 'Probe unavailable.',
    });
  });

  it('never automatically releases a manual review hold, including after a flow edit', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const file = repo.listByLibrary({ libraryId })[0]!;
    repo.setLedger({
      fileId: file.id,
      record: { ...repo.getLedger(file.id)!, state: 'held', reviewReason: 'Inspect subtitles.' },
    });
    const library = createLibraryRepo(db).getById(libraryId)!;
    db.prepare('UPDATE flow SET definition_hash = ? WHERE id = ?').run(
      'changed-flow',
      library.flowId,
    );
    await scan();
    expect(repo.getLedger(file.id)).toMatchObject({
      state: 'held',
      reviewReason: 'Inspect subtitles.',
      holdUntilMs: null,
      attemptCount: 0,
    });
    repo.requeue(file.id);
    expect(repo.getLedger(file.id)).toMatchObject({ state: 'queued', reviewReason: null });
  });

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

  const resumeScan = (input?: { onProgress?: (seen: number) => void; probeConcurrency?: number }) =>
    scanLibrary({
      db,
      libraryId: resumeLibraryId,
      ffprobePath: stubFfprobe,
      nowMs: now,
      onProgress: input?.onProgress,
      probeConcurrency: input?.probeConcurrency,
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
      // `probeConcurrency: 1` on purpose. The rule is "at most one WINDOW's
      // probes are at risk", and this pins the sharpest case of it — a
      // window of one, where every probe is durable the instant it finishes
      // and an interruption costs exactly nothing. The window-sized case is
      // the test below.
      resumeScan({
        probeConcurrency: 1,
        onProgress: (seen) => {
          if (seen !== INTERRUPT_AT) return;
          // Read the DATABASE from inside the walk: the two finished files
          // must already be durable here, not merely queued up in memory for
          // a phase that this interruption is about to prevent.
          probedWhenInterrupted = probedRowCount();
          throw new Interrupted('killed mid-walk');
        },
      }),
    ).rejects.toBeInstanceOf(Interrupted);

    expect(probedWhenInterrupted).toBe(INTERRUPT_AT - 1);
    expect(probedPaths()).toHaveLength(INTERRUPT_AT - 1);
    expect(probedRowCount()).toBe(INTERRUPT_AT - 1);

    // The resuming scan pays only for the files the interrupted one never
    // reached — the whole property: 5 files, 2 already done, 3 to do.
    const resumed = await resumeScan({ probeConcurrency: 1 });
    expect(resumed.seen).toBe(FILE_COUNT);
    expect(resumed.probed).toBe(FILE_COUNT - (INTERRUPT_AT - 1));
    // Every file probed exactly once across BOTH scans.
    expect(probedPaths()).toHaveLength(FILE_COUNT);
    expect(new Set(probedPaths()).size).toBe(FILE_COUNT);
    expect(probedRowCount()).toBe(FILE_COUNT);

    // And a settled library costs nothing at all.
    const settled = await resumeScan({ probeConcurrency: 1 });
    expect(settled.seen).toBe(FILE_COUNT);
    expect(settled.probed).toBe(0);
    expect(probedPaths()).toHaveLength(FILE_COUNT);
  });

  it('spends real ffprobe processes only on files it will record, up to one window', async () => {
    // The same property at the DEFAULT bound, measured through the probe log
    // — an independent record of how many ffprobe processes were actually
    // spawned, not the scanner's own counter.
    //
    // Interrupted at the fifth file, a window of four has closed and its four
    // probes are durable; had it been interrupted at the third, none would
    // be, and the next scan would re-derive them from `probe_json IS NULL`.
    // That is exactly what "at most N at risk" costs, and it is bounded by N
    // rather than by the size of the library.
    await expect(
      resumeScan({
        probeConcurrency: 4,
        onProgress: (seen) => {
          if (seen === 5) throw new Interrupted('killed mid-walk');
        },
      }),
    ).rejects.toBeInstanceOf(Interrupted);

    expect(probedPaths()).toHaveLength(4);
    expect(probedRowCount()).toBe(4);

    const resumed = await resumeScan({ probeConcurrency: 4 });
    expect(resumed.probed).toBe(FILE_COUNT - 4);
    expect(new Set(probedPaths()).size).toBe(FILE_COUNT);
    expect(probedRowCount()).toBe(FILE_COUNT);
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
      resumeScan({
        onProgress: (seen) => {
          if (seen === INTERRUPT_AT) throw new Interrupted('killed mid-walk');
        },
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

/**
 * Spec §4.1: probing "runs at a bounded concurrency". These pin BOTH halves
 * of that sentence — that several probes really do overlap, and that the
 * overlap has a ceiling — plus the three properties the window was not
 * allowed to cost:
 *
 *  - a probe that fails is `unreadable` for its own file and nothing more,
 *  - a window closes with ONE transaction, not one per probe,
 *  - and a file that was SKIPPED still accumulates to a full chunk, which is
 *    what keeps a 100,000-file rescan at ~200 transactions rather than
 *    100,000.
 *
 * All of it is forced through the `probeFileImpl` seam and asserted as
 * counts of observable state — probes in flight, transactions committed,
 * rows written. Never elapsed time, and never "run two things and hope the
 * scheduler interleaves them", which is how a concurrency test passes
 * against broken code.
 */
describe('scanLibrary: bounded-concurrency probing', () => {
  /** A migrated in-memory database, a flow, and `count` one-byte .mkv files. */
  const seedLibraryWithFiles = (count: number): { db: Db; libraryId: string; root: string } => {
    const filesRoot = mkdtempSync(join(tmpdir(), 'trawlarr-concurrency-'));
    for (let i = 0; i < count; i += 1) {
      writeFileSync(join(filesRoot, `f${String(i)}.mkv`), `contents of file ${String(i)}`);
    }
    const seeded = openDatabase({ file: ':memory:' });
    migrate(seeded);
    const flow = createFlowRepo(seeded).create({ name: 'HEVC-conc', definition, nowMs: NOW });
    const library = createLibraryRepo(seeded).create({
      name: 'Concurrent',
      roots: [filesRoot],
      extensions: ['mkv'],
      flowId: flow.id,
      nowMs: NOW,
    });
    return { db: seeded, libraryId: library.id, root: filesRoot };
  };

  /**
   * The document `fakeFfprobe` prints, returned in-process. Takes the path
   * it is answering for so these tests read like the real probe seam, which
   * is per file, even though the answer is fixed.
   */
  const fixedProbe = (path: string): ProbeData =>
    ({
      ...FAKE_PROBE_DOCUMENT,
      format: { ...FAKE_PROBE_DOCUMENT.format, filename: path },
    }) as ProbeData;

  const probedRows = (database: Db, libraryId: string): number =>
    createMediaFileRepo(database)
      .query({ libraryId, limit: 1000, offset: 0 })
      .items.filter((row) => row.probe_json !== null).length;

  it('probes several files at once, without exceeding the configured bound', async () => {
    const { db: seeded, libraryId: id } = seedLibraryWithFiles(20);
    let inFlight = 0;
    let peak = 0;

    const summary = await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return fixedProbe(input.path);
      },
    });

    // Both halves matter: a bound that is never reached proves nothing, and
    // a bound that is exceeded is an unbounded fan-out at 100,000 files.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    // And every file was still probed exactly once and written — a window
    // that dropped its tail would satisfy the two bounds above happily.
    expect(summary.probed).toBe(20);
    expect(probedRows(seeded, id)).toBe(20);
    seeded.close();
  });

  it('probes strictly one at a time when the bound is 1', async () => {
    // The setting really is the bound, in the direction that matters for an
    // operator who wants the old behaviour back on a mount that hates
    // parallel reads.
    const { db: seeded, libraryId: id } = seedLibraryWithFiles(6);
    let inFlight = 0;
    let peak = 0;

    await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 1,
      probeFileImpl: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return fixedProbe(input.path);
      },
    });

    expect(peak).toBe(1);
    seeded.close();
  });

  it('records a failed probe against its own file, without losing the rest of its window', async () => {
    // One undecodable file in a window must not discard the other three
    // probes: that would make a single bad file cost N probes on every scan
    // for the rest of the library's life.
    const { db: seeded, libraryId: id, root: filesRoot } = seedLibraryWithFiles(4);
    const broken = join(filesRoot, 'f2.mkv');

    const summary = await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: async (input) => {
        if (input.path === broken) throw new ProbeError(input.path, 'not a media file');
        return Promise.resolve(fixedProbe(input.path));
      },
    });

    expect(summary.probed).toBe(4);
    expect(summary.unreadable).toBe(1);
    expect(probedRows(seeded, id)).toBe(3);
    seeded.close();
  });

  it('commits one transaction per window, and still lets skipped files reach a full chunk', async () => {
    // The asymmetry rule 3 of the incremental flush is about, restated for a
    // window: 20 files at a bound of 4 is FIVE transactions, not twenty (a
    // flush per probe) and not one (a scan that buffers everything and loses
    // it all to a restart).
    const { db: seeded, libraryId: id } = seedLibraryWithFiles(20);
    const cold: number[] = [];
    await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: (input) => Promise.resolve(fixedProbe(input.path)),
      onTransactionCommitted: (rows) => cold.push(rows),
    });
    expect(cold).toEqual([4, 4, 4, 4, 4]);

    // And on the rescan nothing is probed, so nothing forces a flush and the
    // whole library commits as one chunk.
    const warm: number[] = [];
    const second = await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: (input) => Promise.resolve(fixedProbe(input.path)),
      onTransactionCommitted: (rows) => warm.push(rows),
    });
    expect(second.probed).toBe(0);
    expect(warm).toEqual([20]);
    seeded.close();
  });

  it('still keeps every completed probe when the walk is interrupted', async () => {
    const { db: seeded, libraryId: id } = seedLibraryWithFiles(20);
    await expect(
      scanLibrary({
        db: seeded,
        libraryId: id,
        ffprobePath: 'unused',
        nowMs: () => 0,
        probeConcurrency: 4,
        probeFileImpl: (input) => Promise.resolve(fixedProbe(input.path)),
        onProgress: (seen) => {
          if (seen >= 12) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');

    // Two full windows closed before the eleventh file, so eight probes are
    // on disk: the interruption cost at most one window, never the scan.
    expect(probedRows(seeded, id)).toBe(8);
    // Facts about one file are re-derivable and are kept; a judgement needing
    // the whole picture is not made at all.
    expect(createMediaFileRepo(seeded).missingCount(id)).toBe(0);
    seeded.close();
  });

  it('loses at most one window of probes to an interruption, and re-derives exactly those', async () => {
    // What "N at risk" MEANS, stated as rows rather than as prose: interrupt
    // with a partly-filled window and the scan keeps everything the closed
    // windows wrote, while the open window's files are simply re-probed by
    // the next scan. Nothing is lost, and nothing beyond the window is
    // repeated.
    const { db: seeded, libraryId: id } = seedLibraryWithFiles(20);
    await expect(
      scanLibrary({
        db: seeded,
        libraryId: id,
        ffprobePath: 'unused',
        nowMs: () => 0,
        probeConcurrency: 4,
        probeFileImpl: (input) => Promise.resolve(fixedProbe(input.path)),
        onProgress: (seen) => {
          if (seen >= 11) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');

    // Ten files walked, two windows closed, two files sitting in the open
    // third window when the walk died.
    expect(probedRows(seeded, id)).toBe(8);

    const resumed = await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: (input) => Promise.resolve(fixedProbe(input.path)),
    });
    // 20 files, 8 already durable: the resumed scan pays for the 12 it never
    // recorded and not one probe more.
    expect(resumed.probed).toBe(12);
    expect(probedRows(seeded, id)).toBe(20);

    const settled = await scanLibrary({
      db: seeded,
      libraryId: id,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: (input) => Promise.resolve(fixedProbe(input.path)),
    });
    expect(settled.probed).toBe(0);
    seeded.close();
  });
});
