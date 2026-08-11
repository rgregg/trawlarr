import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CORPUS_DIR = join(process.cwd(), 'cache', 'tdarr-plugins');

export const corpusAvailable = (): boolean =>
  existsSync(join(CORPUS_DIR, 'FlowPlugins', 'CommunityFlowPlugins'));

export const pluginPath = (relative: string): string =>
  join(CORPUS_DIR, 'FlowPlugins', 'CommunityFlowPlugins', relative);
