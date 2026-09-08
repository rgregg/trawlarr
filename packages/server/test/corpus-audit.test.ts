import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPluginLoader } from '@trawlarr/engine';
import { discoverFlowPlugins } from '../src/plugins/sync-source.js';

/**
 * How much of the community corpus this host can actually take.
 *
 * The hand-written compatibility suites in `packages/engine/test/compat` prove
 * a dozen plugins BEHAVE correctly — routing, ffmpeg command mutation, the
 * document store. This one answers the other question, over the whole
 * repository: which plugins does a sync accept at all? It is the same
 * discovery rule and the same loader a real `POST /plugins/sources/:id/sync`
 * uses, so a plugin that fails here is a plugin an operator cannot install,
 * and the reason printed here is the reason they would be shown.
 *
 * Loading runs the module body and `details()` — third-party code, as a sync
 * does — and never `plugin()`, which is the half that touches files.
 */
const CORPUS_DIR = join(process.cwd(), 'cache', 'tdarr-plugins');
const available = existsSync(join(CORPUS_DIR, 'FlowPlugins', 'CommunityFlowPlugins'));

if (!available) {
  console.warn(
    `[compat] Tdarr plugin corpus not found at ${CORPUS_DIR} — skipping the corpus audit. ` +
      'Run `pnpm compat:fetch` first.',
  );
}

describe.runIf(available)('the community corpus, as a sync would install it', () => {
  it('loads every discovered flow plugin and reports any it cannot', () => {
    const loader = createPluginLoader();
    const candidates = discoverFlowPlugins(CORPUS_DIR);
    const failures: { relPath: string; reason: string }[] = [];
    let usable = 0;

    for (const candidate of candidates) {
      try {
        const loaded = loader.load(candidate.absPath);
        // "Loads" is not enough on its own: the editor needs a name to show
        // and an outputs array to draw ports from, and a plugin missing
        // either would install and then be unusable in a flow.
        expect(typeof loaded.details.name).toBe('string');
        expect(Array.isArray(loaded.details.outputs)).toBe(true);
        expect(Array.isArray(loaded.details.inputs)).toBe(true);
        usable += 1;
      } catch (error) {
        failures.push({
          relPath: candidate.relPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // The count is asserted as a FLOOR rather than an exact number: upstream
    // adds plugins, and a test that had to be edited for every addition would
    // be edited without being read. A drop below the floor means this host
    // stopped accepting plugins it used to accept.
    expect(candidates.length).toBeGreaterThanOrEqual(85);
    expect({ total: candidates.length, usable, failures }).toEqual({
      total: candidates.length,
      usable: candidates.length,
      failures: [],
    });
  });
});
