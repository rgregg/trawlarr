import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkScope } from './scoped-walk.js';

let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scoped-walk-'));
  root = join(base, 'library');
  mkdirSync(join(root, 'Film A'), { recursive: true });
  mkdirSync(join(root, 'Film B', 'extras'), { recursive: true });
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  writeFileSync(join(root, 'Film A', 'a.mkv'), 'a');
  writeFileSync(join(root, 'Film A', 'a.nfo'), 'a');
  writeFileSync(join(root, 'Film B', 'b.mkv'), 'b');
  writeFileSync(join(root, 'Film B', 'extras', 'b-extra.mkv'), 'b');
  writeFileSync(join(root, '.trawlarr', 'trash', 'deleted.mkv'), 'x');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const collect = async (scope: string[], libraryRoots: string[] = [root]): Promise<string[]> => {
  const found: string[] = [];
  for await (const entry of walkScope({
    scope,
    libraryRoots,
    extensions: ['mkv'],
    exclude: [join(root, '.trawlarr')],
  })) {
    found.push(entry.path);
  }
  return found.sort();
};

describe('walkScope', () => {
  it('yields a file named directly, without reading any directory', async () => {
    expect(await collect([join(root, 'Film A', 'a.mkv')])).toEqual([join(root, 'Film A', 'a.mkv')]);
  });

  it('walks a folder, and only that folder', async () => {
    expect(await collect([join(root, 'Film B')])).toEqual([
      join(root, 'Film B', 'b.mkv'),
      join(root, 'Film B', 'extras', 'b-extra.mkv'),
    ]);
  });

  it('yields nothing for a path that does not exist', async () => {
    expect(await collect([join(root, 'Film C', 'gone.mkv'), join(root, 'Film C')])).toEqual([]);
  });

  it('skips a file whose extension the library does not want', async () => {
    expect(await collect([join(root, 'Film A', 'a.nfo')])).toEqual([]);
  });

  it("never yields trawlarr's own scratch, even when it is named directly", async () => {
    const scratch = join(root, 'Film A', '.trawlarr-replace-1234.mkv');
    writeFileSync(scratch, 'x');
    expect(await collect([scratch])).toEqual([]);
  });

  it('never yields a symlink named directly, as the full walk never does', async () => {
    const link = join(root, 'Film A', 'link.mkv');
    symlinkSync(join(root, 'Film B', 'b.mkv'), link);
    expect(await collect([link])).toEqual([]);
  });

  // Review Focus 2: a watcher burst reports a new folder AND the file in it.
  it('yields a file once when it is named and its folder is too', async () => {
    expect(await collect([join(root, 'Film A', 'a.mkv'), join(root, 'Film A')])).toEqual([
      join(root, 'Film A', 'a.mkv'),
    ]);
  });

  it('prunes a reserved directory inside a scoped folder', async () => {
    expect(await collect([root])).toEqual([
      join(root, 'Film A', 'a.mkv'),
      join(root, 'Film B', 'b.mkv'),
      join(root, 'Film B', 'extras', 'b-extra.mkv'),
    ]);
  });

  // The reason the feature exists (spec §7): what a scoped scan reads must
  // depend on the scope, not on how big the library around it is.
  it('opens the same directories however many other folders the library has', async () => {
    const opened = async (others: number): Promise<number> => {
      for (let index = 0; index < others; index += 1) {
        mkdirSync(join(root, `Other ${String(index)}`), { recursive: true });
        writeFileSync(join(root, `Other ${String(index)}`, 'x.mkv'), 'x');
      }
      let count = 0;
      for await (const entry of walkScope({
        scope: [join(root, 'Film B')],
        libraryRoots: [root],
        extensions: ['mkv'],
        exclude: [join(root, '.trawlarr')],
        openDir: async (path) => {
          count += 1;
          return await opendir(path);
        },
      })) {
        void entry;
      }
      return count;
    };

    const small = await opened(2);
    const large = await opened(40);

    expect(small).toBe(2); // Film B and Film B/extras.
    expect(large).toBe(small);
  });

  // The reserved directory is configured by its real path while the library
  // root — and so every scope path — is spelled through a symlink alias.
  // Pruning judged against the scope folder alone would not see the alias.
  it('prunes by the library roots, so an aliased root still hides its reserved directory', async () => {
    const alias = join(base, 'alias');
    symlinkSync(root, alias);
    mkdirSync(join(root, 'Film B', 'staging'));
    writeFileSync(join(root, 'Film B', 'staging', 'part.mkv'), 'x');

    const found: string[] = [];
    for await (const entry of walkScope({
      scope: [join(alias, 'Film B')],
      libraryRoots: [alias],
      extensions: ['mkv'],
      exclude: [join(root, 'Film B', 'staging')],
    })) {
      found.push(entry.path);
    }

    expect(found.sort()).toEqual([
      join(alias, 'Film B', 'b.mkv'),
      join(alias, 'Film B', 'extras', 'b-extra.mkv'),
    ]);
  });
});
