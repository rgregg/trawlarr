import { describe, expect, it } from 'vitest';
import { palette, modifiesFfmpegCommand, paletteCount } from './palette-model.js';
import type { EditorPlugin } from './flow-canvas-model.js';

const plugin = (over: Partial<EditorPlugin> & { id: string }): EditorPlugin => ({
  name: over.id,
  description: '',
  tags: '',
  version: '1.0.0',
  enabled: true,
  isStartPlugin: false,
  source: 'first-party',
  ...over,
  details: {
    name: over.name ?? over.id,
    description: '',
    tags: over.tags ?? '',
    style: { borderColor: '#000' },
    isStartPlugin: over.isStartPlugin ?? false,
    pType: '',
    sidebarPosition: 0,
    icon: '',
    inputs: [],
    outputs: [{ number: 1, tooltip: 'Continue' }],
    requiresVersion: '1.0.0',
    ...over.details,
  },
});

const start = plugin({ id: 'trawlarr:start', isStartPlugin: true });
const onError = plugin({
  id: 'trawlarr:onError',
  details: { pType: 'onFlowError' } as EditorPlugin['details'],
});
const check = plugin({ id: 'trawlarr:checkCondition', tags: 'condition,branch' });
const encoder = plugin({ id: 'trawlarr:setVideoEncoder', tags: 'ffmpeg,video' });
const community = plugin({
  id: 'tdarr:ffmpegCommandSetContainer',
  name: 'Set Container',
  source: 'installed',
  sourceId: 'tdarr',
});

const names = (groups: ReturnType<typeof palette>): string[][] =>
  groups.map((group) => [group.title, ...group.sections.map((section) => section.title)]);

const ids = (groups: ReturnType<typeof palette>): string[] =>
  groups.flatMap((group) =>
    group.sections.flatMap((section) => section.entries.map((entry) => entry.plugin.id)),
  );

const build = (over: Partial<Parameters<typeof palette>[0]> = {}) =>
  palette({
    plugins: [start, onError, check, encoder, community],
    search: '',
    startPresent: false,
    errorEntryPresent: false,
    ...over,
  });

describe('component palette', () => {
  it('puts built-in components before each plugin source, named by the source', () => {
    const groups = build();
    expect(groups.map((group) => group.title)).toEqual(['Built-in', 'tdarr']);
  });

  // A component whose only job is to add ffmpeg arguments is a different kind
  // of decision from one that branches the flow, and an operator building a
  // transcode wants them together rather than interleaved by sidebar order.
  it('separates the components that build the ffmpeg command from the rest', () => {
    expect(names(build())).toEqual([
      ['Built-in', 'Other components', 'ffmpeg command'],
      ['tdarr', ''],
    ]);
  });

  it('recognises an ffmpeg-command component by its tag or its published path', () => {
    expect(modifiesFfmpegCommand(encoder)).toBe(true);
    expect(modifiesFfmpegCommand(community)).toBe(true);
    expect(modifiesFfmpegCommand(check)).toBe(false);
    // "ffmpeg" as a substring of another tag is not the tag itself.
    expect(modifiesFfmpegCommand(plugin({ id: 'x', tags: 'ffmpeg-ish,other' }))).toBe(false);
  });

  // Only one Start and one On Error may ever exist in a flow, so once the
  // graph has them a permanently unusable card is noise, not information.
  it('hides Start and On Error once the flow already has one', () => {
    expect(ids(build())).toContain('trawlarr:start');
    expect(ids(build({ startPresent: true }))).not.toContain('trawlarr:start');
    expect(ids(build({ startPresent: true }))).toContain('trawlarr:onError');
    expect(ids(build({ errorEntryPresent: true }))).not.toContain('trawlarr:onError');
  });

  // A disabled plugin is a problem to fix, not a rule of the graph: hiding it
  // would leave an operator wondering where their installed plugin went.
  it('keeps a disabled plugin visible and says why it cannot be added', () => {
    const groups = palette({
      plugins: [plugin({ id: 'tdarr:x', source: 'installed', sourceId: 'tdarr', enabled: false })],
      search: '',
      startPresent: false,
      errorEntryPresent: false,
    });
    expect(groups[0]!.sections[0]!.entries[0]!.unavailable).toBe('Disabled');
  });

  it('searches name, id, description, tags and source, and can match nothing', () => {
    expect(ids(build({ search: 'container' }))).toEqual(['tdarr:ffmpegCommandSetContainer']);
    expect(ids(build({ search: 'ffmpeg' })).length).toBeGreaterThan(1);
    expect(paletteCount(build({ search: 'nothing matches this' }))).toBe(0);
  });

  it('falls back to the source kind when an installed plugin reports no source id', () => {
    const groups = palette({
      plugins: [plugin({ id: 'path:one', source: 'path' })],
      search: '',
      startPresent: false,
      errorEntryPresent: false,
    });
    expect(groups.map((group) => group.title)).toEqual(['path']);
  });
});
