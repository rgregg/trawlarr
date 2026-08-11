import fsextra from 'fs-extra';
import gracefulfs from 'graceful-fs';
import importFresh from 'import-fresh';
import mvdir from 'mvdir';
import ncp from 'ncp';
import upath from 'upath';
import axios from 'axios';
import { parseArgsStringToArgv } from 'string-argv';
import type { ConfigVars, PluginDeps } from '@trawlarr/plugin-api';
import { requireFromString } from './require-from-string.js';

/**
 * The modules the contract injects into plugin scope. These are real npm
 * packages and their behaviour is part of the contract, so they are passed
 * through rather than wrapped.
 */
export const buildPluginDeps = (input: {
  configVars: ConfigVars;
  crudTransDBN: PluginDeps['crudTransDBN'];
  axiosMiddleware: PluginDeps['axiosMiddleware'];
}): PluginDeps => ({
  fsextra,
  gracefulfs,
  upath,
  axios,
  ncp,
  mvdir,
  parseArgsStringToArgv,
  importFresh: (path: string) => importFresh(path),
  requireFromString: (pluginText: string, relativePath: string) =>
    requireFromString({ code: pluginText, filename: relativePath }),
  axiosMiddleware: input.axiosMiddleware,
  crudTransDBN: input.crudTransDBN,
  configVars: input.configVars,
});

/**
 * Classic plugins are out of scope; this rejects rather than pretending.
 * Wired into PluginInputArgs.installClassicPluginDeps (spec §2.8), which is
 * the name plugins actually call.
 */
export const rejectClassicPluginDeps = async (deps: string[]): Promise<never> => {
  throw new Error(
    `This plugin requires classic-plugin dependencies (${deps.join(', ')}), but trawlarr ` +
      `does not support Tdarr classic plugins. Use a flow plugin instead.`,
  );
};
