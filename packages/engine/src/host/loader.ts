import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
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
  const cache = new Map<string, { mtimeMs: number; loaded: LoadedPlugin }>();

  return {
    load(absPath, options) {
      let mtimeMs: number;
      let code: string;
      try {
        mtimeMs = statSync(absPath).mtimeMs;
        code = readFileSync(absPath, 'utf8');
      } catch (cause) {
        throw new PluginLoadError(absPath, (cause as Error).message, { cause });
      }

      const fresh = options?.fresh === true;
      const cached = cache.get(absPath);
      if (!fresh && cached !== undefined && cached.mtimeMs === mtimeMs) {
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
        version: options?.version ?? details.requiresVersion ?? '0.0.0',
        details,
        module,
      };

      if (!fresh) cache.set(absPath, { mtimeMs, loaded });
      return loaded;
    },

    clear() {
      cache.clear();
    },
  };
};
