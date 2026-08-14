import { readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';

/** `movie.mkv` -> `movie`. Basename with its final extension stripped. */
const stemOf = (path: string): string => {
  const base = basename(path);
  const ext = extname(base);
  return ext === '' ? base : base.slice(0, -ext.length);
};

/**
 * Sidecar files sharing `filePath`'s basename: `movie.en.srt` and
 * `movie.nfo` are companions of `movie.mkv`, but `movie2.srt` and
 * `movie-extended.srt` are not, and `filePath` itself never is.
 *
 * Matching is on the media stem with the remainder required to be either
 * empty or a dot-separated suffix (`.en.srt`, `.nfo`) — that boundary is
 * what admits language-tagged sidecars while rejecting a different file
 * whose name merely starts the same.
 */
export const findCompanions = async (input: {
  filePath: string;
  companionExtensions: readonly string[];
}): Promise<string[]> => {
  const dir = dirname(input.filePath);
  const mediaBase = basename(input.filePath);
  const stem = stemOf(input.filePath);
  const wanted = new Set(input.companionExtensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const name of entries) {
    if (name === mediaBase) continue;
    if (!name.startsWith(stem)) continue;
    const remainder = name.slice(stem.length);
    if (remainder.length === 0 || remainder[0] !== '.') continue;

    const extension = extname(name).replace('.', '').toLowerCase();
    if (!wanted.has(extension)) continue;

    found.push(join(dir, name));
  }
  return found.sort();
};

/**
 * Where a companion should live once its media file moves from
 * `oldMediaPath` to `newMediaPath`: the same suffix (`.en.srt`, `.nfo`)
 * carried onto the new stem, in the new file's directory.
 */
export const companionTargetFor = (input: {
  companionPath: string;
  oldMediaPath: string;
  newMediaPath: string;
}): string => {
  const oldStem = stemOf(input.oldMediaPath);
  const companionBase = basename(input.companionPath);

  if (!companionBase.startsWith(oldStem)) {
    // Not actually a companion of oldMediaPath by this module's own
    // matching rule — best effort: keep its name, just follow the move.
    return join(dirname(input.newMediaPath), companionBase);
  }

  const suffix = companionBase.slice(oldStem.length);
  const newStem = stemOf(input.newMediaPath);
  return join(dirname(input.newMediaPath), `${newStem}${suffix}`);
};

/**
 * First path among `target`, `target (1)`, `target (2)`, ... that does not
 * currently exist. Used so a companion move never overwrites a file that
 * happens to already be sitting at the destination name — losing a file to
 * a silent overwrite is worse than a slightly odd name.
 */
const uniqueDestination = async (target: string): Promise<string> => {
  const { dir, name, ext } = parse(target);
  let candidate = target;
  let attempt = 1;
  for (;;) {
    try {
      await stat(candidate);
    } catch {
      return candidate; // nothing there: safe to use
    }
    candidate = join(dir, `${name} (${attempt})${ext}`);
    attempt += 1;
  }
};

/**
 * Moves each companion alongside its media file's move, following
 * {@link companionTargetFor}. A no-op when the media path is unchanged.
 *
 * If a computed destination is already occupied by an unrelated file, the
 * companion is renamed to a disambiguated `name (1).ext` path instead of
 * overwriting it — see {@link uniqueDestination}.
 */
export const moveCompanions = async (input: {
  companions: readonly string[];
  oldMediaPath: string;
  newMediaPath: string;
}): Promise<void> => {
  if (resolve(input.oldMediaPath) === resolve(input.newMediaPath)) return;

  for (const companion of input.companions) {
    const target = companionTargetFor({
      companionPath: companion,
      oldMediaPath: input.oldMediaPath,
      newMediaPath: input.newMediaPath,
    });
    const destination =
      resolve(target) === resolve(companion) ? target : await uniqueDestination(target);
    await rename(companion, destination);
  }
};
