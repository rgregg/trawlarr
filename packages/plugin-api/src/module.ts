import type { PluginDetails } from './details.js';
import type { PluginInputArgs, PluginOutputArgs } from './args.js';

export interface PluginModule {
  details: () => PluginDetails;
  plugin: (args: PluginInputArgs) => PluginOutputArgs | Promise<PluginOutputArgs>;
}
