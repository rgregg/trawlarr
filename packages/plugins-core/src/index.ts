import type { PluginModule } from '@trawlarr/plugin-api';
import * as start from './start/index.js';
import * as checkVideoCodec from './checkVideoCodec/index.js';
import * as checkAudioStream from './checkAudioStream/index.js';
import * as beginCommand from './beginCommand/index.js';
import * as setVideoEncoder from './setVideoEncoder/index.js';
import * as execute from './execute/index.js';
import * as verifyOutput from './verifyOutput/index.js';
import * as replaceOriginalFile from './replaceOriginalFile/index.js';
import * as failFile from './failFile/index.js';
import * as writeToLog from './writeToLog/index.js';
import * as checkCondition from './checkCondition/index.js';
import * as audioTracks from './audioTracks/index.js';
import * as subtitleTracks from './subtitleTracks/index.js';
import * as setContainer from './setContainer/index.js';
import * as onError from './onError/index.js';
import * as holdForReview from './holdForReview/index.js';

const entry = (id: string, module: PluginModule): { id: string; module: PluginModule } => ({
  id,
  module,
});

export const FIRST_PARTY_PLUGINS: Record<string, { id: string; module: PluginModule }> = {
  'trawlarr:start': entry('trawlarr:start', start),
  'trawlarr:checkVideoCodec': entry('trawlarr:checkVideoCodec', checkVideoCodec),
  'trawlarr:checkAudioStream': entry('trawlarr:checkAudioStream', checkAudioStream),
  'trawlarr:beginCommand': entry('trawlarr:beginCommand', beginCommand),
  'trawlarr:setVideoEncoder': entry('trawlarr:setVideoEncoder', setVideoEncoder),
  'trawlarr:execute': entry('trawlarr:execute', execute),
  'trawlarr:verifyOutput': entry('trawlarr:verifyOutput', verifyOutput),
  'trawlarr:replaceOriginal': entry('trawlarr:replaceOriginal', replaceOriginalFile),
  'trawlarr:writeToLog': entry('trawlarr:writeToLog', writeToLog),
  'trawlarr:failFile': entry('trawlarr:failFile', failFile),
  'trawlarr:checkCondition': entry('trawlarr:checkCondition', checkCondition),
  'trawlarr:audioTracks': entry('trawlarr:audioTracks', audioTracks),
  'trawlarr:subtitleTracks': entry('trawlarr:subtitleTracks', subtitleTracks),
  'trawlarr:setContainer': entry('trawlarr:setContainer', setContainer),
  'trawlarr:onError': entry('trawlarr:onError', onError),
  'trawlarr:holdForReview': entry('trawlarr:holdForReview', holdForReview),
};

// The property catalogue is part of this package's public surface because the
// API serves it to the flow editor: the list an operator inserts from must be
// the one `readFlowValue` can answer, not a copy maintained in the web bundle.
export {
  FLOW_FIELDS,
  FLOW_FIELD_DOCS,
  FLOW_FIELD_NAMESPACES,
  readFlowValue,
  renderMessageTemplate,
} from './flow-values.js';
