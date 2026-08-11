import type { PluginModule } from '@trawlarr/plugin-api';
import * as start from './start/index.js';
import * as checkVideoCodec from './checkVideoCodec/index.js';
import * as beginCommand from './beginCommand/index.js';
import * as setVideoEncoder from './setVideoEncoder/index.js';
import * as execute from './execute/index.js';

const entry = (id: string, module: PluginModule): { id: string; module: PluginModule } => ({
  id,
  module,
});

export const FIRST_PARTY_PLUGINS: Record<string, { id: string; module: PluginModule }> = {
  'trawlarr:start': entry('trawlarr:start', start),
  'trawlarr:checkVideoCodec': entry('trawlarr:checkVideoCodec', checkVideoCodec),
  'trawlarr:beginCommand': entry('trawlarr:beginCommand', beginCommand),
  'trawlarr:setVideoEncoder': entry('trawlarr:setVideoEncoder', setVideoEncoder),
  'trawlarr:execute': entry('trawlarr:execute', execute),
};
