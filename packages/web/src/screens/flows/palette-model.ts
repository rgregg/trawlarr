import type { EditorPlugin } from './flow-canvas-model.js';

/**
 * The component palette's shape: which components an operator can see right
 * now, under which heading, and — for those that are visible but cannot be
 * added — the reason the Add button is off.
 *
 * A pure function rather than JSX conditionals, because the interesting part
 * is the rules (what is hidden, what is merely disabled, what belongs
 * together), and rules are what a test can hold.
 */
export interface PaletteEntry {
  plugin: EditorPlugin;
  /** null when the component can be added; otherwise the reason it cannot. */
  unavailable: string | null;
}

export interface PaletteSection {
  /** '' for a group's single list; sections are only titled when they split. */
  title: string;
  entries: PaletteEntry[];
}

export interface PaletteGroup {
  key: string;
  title: string;
  sections: PaletteSection[];
}

export const BUILT_IN_GROUP = 'Built-in';
export const FFMPEG_SECTION = 'ffmpeg command';
export const GENERAL_SECTION = 'Other components';

const isStart = (plugin: EditorPlugin): boolean =>
  plugin.isStartPlugin || plugin.details.isStartPlugin;

const isErrorEntry = (plugin: EditorPlugin): boolean => plugin.details.pType === 'onFlowError';

/**
 * Components that build up the ffmpeg command rather than deciding anything.
 *
 * Recognised from the two things such a component actually declares: the
 * `ffmpeg` tag the first-party nodes carry, and the `ffmpegCommand` directory
 * every community one is published under, which its plugin id is derived
 * from. Neither is a list of ids — a list would silently stop recognising
 * the next plugin upstream adds.
 */
export const modifiesFfmpegCommand = (plugin: EditorPlugin): boolean =>
  /ffmpegcommand/i.test(plugin.id) ||
  /ffmpegcommand/i.test(plugin.details.name) ||
  plugin.tags
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .includes('ffmpeg');

const groupKey = (plugin: EditorPlugin): string =>
  plugin.source === 'first-party' ? '' : (plugin.sourceId ?? plugin.source);

const groupTitle = (key: string): string => (key === '' ? BUILT_IN_GROUP : key);

const matches = (plugin: EditorPlugin, search: string): boolean =>
  `${plugin.name} ${plugin.id} ${plugin.description} ${plugin.tags} ${plugin.source}`
    .toLowerCase()
    .includes(search.toLowerCase().trim());

const byPosition = (left: EditorPlugin, right: EditorPlugin): number =>
  left.details.sidebarPosition - right.details.sidebarPosition ||
  left.name.localeCompare(right.name);

/**
 * Start and On Error are HIDDEN once the flow already has one, rather than
 * shown disabled: a flow may only ever contain one of each, so a permanently
 * unusable card is noise in the one list an operator scans while building. A
 * disabled plugin stays visible with its reason, because that one is a
 * problem to fix rather than a rule of the graph.
 */
export function palette(input: {
  plugins: EditorPlugin[];
  search: string;
  startPresent: boolean;
  errorEntryPresent: boolean;
}): PaletteGroup[] {
  const visible = input.plugins
    .filter((plugin) => !(isStart(plugin) && input.startPresent))
    .filter((plugin) => !(isErrorEntry(plugin) && input.errorEntryPresent))
    .filter((plugin) => matches(plugin, input.search))
    .sort(byPosition);

  const groups = new Map<string, EditorPlugin[]>();
  for (const plugin of visible) {
    const key = groupKey(plugin);
    groups.set(key, [...(groups.get(key) ?? []), plugin]);
  }

  return (
    [...groups.entries()]
      // Built-in first — its key is empty, so it sorts before every source
      // id — then plugin sources by name, so the order an operator learns
      // stays put as sources come and go.
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, plugins]) => {
        const entries = plugins.map((plugin) => ({
          plugin,
          unavailable: plugin.enabled ? null : 'Disabled',
        }));
        const ffmpeg = entries.filter((entry) => modifiesFfmpegCommand(entry.plugin));
        const rest = entries.filter((entry) => !modifiesFfmpegCommand(entry.plugin));
        const sections =
          ffmpeg.length === 0 || rest.length === 0
            ? [{ title: '', entries }]
            : [
                { title: GENERAL_SECTION, entries: rest },
                { title: FFMPEG_SECTION, entries: ffmpeg },
              ];
        return { key, title: groupTitle(key), sections };
      })
  );
}

export const paletteCount = (groups: PaletteGroup[]): number =>
  groups.reduce(
    (total, group) =>
      total + group.sections.reduce((count, section) => count + section.entries.length, 0),
    0,
  );
