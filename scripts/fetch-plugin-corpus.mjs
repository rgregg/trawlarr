#!/usr/bin/env node
import { mkdirSync, existsSync, rmSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Pinned so pull-request CI is deterministic. The nightly workflow overrides
// this with `master` to detect upstream contract drift.
// Pinned 2026-08-11 to HaveAGitGat/Tdarr_Plugins@master at the time the
// compatibility harness (Task 19) was verified passing against it.
const PINNED_SHA = process.env.TDARR_PLUGINS_REF ?? '26c97a52f9dcf5fc6faeb751071cb82cdf97ca4e';
const REPO = 'HaveAGitGat/Tdarr_Plugins';
const CACHE = join(process.cwd(), 'cache', 'tdarr-plugins');
const marker = join(CACHE, `.ref-${PINNED_SHA}`);

if (existsSync(marker)) {
  console.log(`Plugin corpus already present at ${PINNED_SHA}.`);
  process.exit(0);
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

const url = `https://codeload.github.com/${REPO}/tar.gz/${PINNED_SHA}`;
console.log(`Fetching ${url}`);

const response = await fetch(url);
if (!response.ok) {
  console.error(`Failed to fetch corpus: HTTP ${response.status}`);
  process.exit(1);
}

const tarball = join(CACHE, 'corpus.tar.gz');
await pipeline(response.body, createWriteStream(tarball));
execFileSync('tar', ['-xzf', tarball, '-C', CACHE, '--strip-components=1'], {
  stdio: 'inherit',
});
rmSync(tarball);
execFileSync('touch', [marker]);

console.log(`Plugin corpus ready at ${CACHE} (${PINNED_SHA}).`);
console.log('These plugins are GPL-3.0 and are never committed to this repository.');
