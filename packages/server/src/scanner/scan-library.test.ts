import { execFile } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
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
