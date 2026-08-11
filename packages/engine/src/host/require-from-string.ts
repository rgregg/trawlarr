import Module from 'node:module';
import { dirname } from 'node:path';

/**
 * Internal-but-stable Node module internals. `require-from-string` on npm
 * uses exactly these; they are how you get a real CommonJS environment
 * (working `require`, `__dirname`, correct resolution paths) rather than a
 * bare `eval`. Plugins genuinely require builtins, so this matters.
 */
interface ModuleInternals {
  _compile(code: string, filename: string): void;
  _nodeModulePaths(dir: string): string[];
  paths: string[];
  filename: string;
  exports: Record<string, unknown>;
}

const ModuleCtor = Module as unknown as {
  new (id: string, parent?: Module): ModuleInternals;
  _nodeModulePaths(dir: string): string[];
};

/**
 * Compile CommonJS source into a fresh module instance.
 *
 * Deliberately does not populate require.cache, so each call re-executes THIS
 * source and gets its own `module.exports` — which is what the contract's
 * `importFresh` semantics require.
 *
 * The freshness stops there, and it is worth being precise about the limit:
 * anything the plugin itself `require`s resolves through Node's ordinary
 * module cache and is therefore SHARED across every plugin and every job in
 * the process. A plugin that keeps state in a helper module it requires, or
 * that mutates a shared dependency, will see that state carried from one job
 * into the next. Nothing here isolates plugins from each other — see the
 * README's "Plugins run as the service user" section.
 */
export const requireFromString = (input: {
  code: string;
  filename: string;
}): Record<string, unknown> => {
  const mod = new ModuleCtor(input.filename);
  mod.filename = input.filename;
  mod.paths = ModuleCtor._nodeModulePaths(dirname(input.filename));
  mod._compile(input.code, input.filename);
  return mod.exports;
};
