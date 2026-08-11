import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PluginDetails, PluginModule } from '@trawlarr/plugin-api';
import { requireFromString } from './require-from-string.js';

export class PluginLoadError extends Error {
  readonly absPath: string;

  constructor(absPath: string, message: string, options?: { cause?: unknown }) {
    super(`Failed to load plugin ${absPath}: ${message}`, options);
    this.name = 'PluginLoadError';
    this.absPath = absPath;
  }
}

export interface LoadedPlugin {
  id: string;
  absPath: string;
  version: string;
  details: PluginDetails;
  module: PluginModule;
}

export interface PluginLoader {
  load(absPath: string, options?: { version?: string; fresh?: boolean }): LoadedPlugin;
  clear(): void;
}

const idFor = (absPath: string): string =>
  createHash('sha256').update(absPath).digest('hex').slice(0, 16);

/**
 * A plugin's identity as a *version*: the SHA-256 of its source.
 *
 * Not `details().requiresVersion` — that is the host-compatibility level the
 * plugin demands, not a version of the plugin itself, and it typically does
 * not move when the plugin's code does. Defaulting to it meant a plugin whose
 * behaviour changed kept the same version, so nothing downstream that keys on
 * plugin version (notably the flow signature) would ever invalidate.
 */
export const contentVersion = (code: string): string =>
  `sha256-${createHash('sha256').update(code).digest('hex').slice(0, 16)}`;

const assertPluginModule = (absPath: string, exports: Record<string, unknown>): PluginModule => {
  if (typeof exports.details !== 'function' || typeof exports.plugin !== 'function') {
    throw new PluginLoadError(
      absPath,
      'a plugin must export both a details() and a plugin() function',
    );
  }
  return exports as unknown as PluginModule;
};

const readDetails = (absPath: string, module: PluginModule): PluginDetails => {
  let details: PluginDetails;
  try {
    details = module.details();
  } catch (cause) {
    throw new PluginLoadError(absPath, `details() threw: ${(cause as Error).message}`, { cause });
  }

  if (details === null || typeof details !== 'object') {
    throw new PluginLoadError(absPath, 'details() must return an object');
  }
  if (!Array.isArray(details.outputs)) {
    throw new PluginLoadError(absPath, 'details() must return an outputs array');
  }
  if (!Array.isArray(details.inputs)) {
    throw new PluginLoadError(absPath, 'details() must return an inputs array');
  }
  return details;
};

export const createPluginLoader = (): PluginLoader => {
  // Keyed on path + a hash of the file's CONTENTS, not its mtime. mtime has
  // coarse granularity on some filesystems and is trivially preserved by
  // editors and deploy tooling, so an mtime key can serve stale code for a
  // file that genuinely changed. Hashing costs one hash over bytes we have
  // already read in order to compile them.
  const cache = new Map<string, { contentHash: string; loaded: LoadedPlugin }>();

  return {
    load(absPath, options) {
      let code: string;
      try {
        code = readFileSync(absPath, 'utf8');
      } catch (cause) {
        throw new PluginLoadError(absPath, (cause as Error).message, { cause });
      }

      const contentHash = contentVersion(code);
      const fresh = options?.fresh === true;
      const cached = cache.get(absPath);
      if (!fresh && cached !== undefined && cached.contentHash === contentHash) {
        return cached.loaded;
      }

      let exports: Record<string, unknown>;
      try {
        exports = requireFromString({ code, filename: absPath });
      } catch (cause) {
        throw new PluginLoadError(absPath, (cause as Error).message, { cause });
      }

      const module = assertPluginModule(absPath, exports);
      const details = readDetails(absPath, module);

      const loaded: LoadedPlugin = {
        id: idFor(absPath),
        absPath,
        version: options?.version ?? contentHash,
        details,
        module,
      };

      if (!fresh) cache.set(absPath, { contentHash, loaded });
      return loaded;
    },

    clear() {
      cache.clear();
    },
  };
};
