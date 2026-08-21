/**
 * The namespace first-party plugins live in. A source may never claim it:
 * an installed plugin shadowing `trawlarr:execute` would change what every
 * existing flow does without any flow being edited, and `flowDefinitionHash`
 * would not move, so nothing would be re-evaluated.
 */
export const FIRST_PARTY_NAMESPACE = 'trawlarr';

export class PluginIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginIdError';
  }
}

export interface InstalledPluginId {
  sourceSlug: string;
  pluginName: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * A plugin's directory name in its source tree — `ffmpegCommandSetContainer`.
 * Kept deliberately permissive on case, because it is upstream's name and not
 * ours to normalise; normalising it would break the identity translation a
 * Tdarr flow import depends on (spec 2.7).
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const assertValidSourceSlug = (slug: string): void => {
  if (slug === FIRST_PARTY_NAMESPACE) {
    throw new PluginIdError(
      `"${FIRST_PARTY_NAMESPACE}" is reserved for trawlarr's own plugins. A source using it ` +
        `could install a plugin that silently replaces a first-party node in every flow you ` +
        `already have. Choose another name.`,
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new PluginIdError(
      `Plugin source name "${slug}" is not usable as an id prefix. Use lowercase letters, ` +
        `digits and hyphens, starting with a letter or digit — for example "tdarr" or ` +
        `"my-plugins". Uppercase is refused so two sources cannot differ only by case, and a ` +
        `colon is refused because it separates the source from the plugin name.`,
    );
  }
};

export const formatPluginId = (id: InstalledPluginId): string =>
  `${id.sourceSlug}:${id.pluginName}`;

/**
 * Read an id as an INSTALLED plugin reference, or `null` if it is anything
 * else — a first-party id, an absolute path (still how a community plugin is
 * named without a source), or malformed. Returning null rather than throwing
 * is what lets every caller try this first and fall through.
 */
export const parsePluginId = (raw: string): InstalledPluginId | null => {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;

  const sourceSlug = raw.slice(0, separator);
  const pluginName = raw.slice(separator + 1);

  if (sourceSlug === FIRST_PARTY_NAMESPACE) return null;
  if (!SLUG_PATTERN.test(sourceSlug)) return null;
  // Catches `C:\plugins\...` and any other path that happens to carry a colon.
  if (!NAME_PATTERN.test(pluginName)) return null;

  return { sourceSlug, pluginName };
};
