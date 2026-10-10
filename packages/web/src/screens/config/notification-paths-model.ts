/**
 * The "Notification paths" setting as the rows a person edits.
 *
 * The stored shape is the one remote nodes use (`serverPath`/`nodePath`),
 * where the sending application stands in the node's place. Those names mean
 * nothing on this screen, so the rows are named for what they are: the path
 * as the other application reports it, and the path as trawlarr sees it.
 */
export interface NotificationPathRow {
  key: string;
  theirs: string;
  ours: string;
}

export const rowsFromMap = (
  map: { serverPath: string; nodePath: string }[],
): NotificationPathRow[] =>
  map.map((entry) => ({
    key: `${entry.nodePath}\u0000${entry.serverPath}`,
    theirs: entry.nodePath,
    ours: entry.serverPath,
  }));

export const mapFromRows = (
  rows: NotificationPathRow[],
): { serverPath: string; nodePath: string }[] =>
  rows
    .map((row) => ({ serverPath: row.ours.trim(), nodePath: row.theirs.trim() }))
    .filter((entry) => entry.serverPath !== '' || entry.nodePath !== '');

/**
 * A map that has not been read cannot be edited: saving would replace what
 * the server holds with only what was typed. `null` is "not loaded yet" (or
 * the load failed); an empty list is a loaded, empty map and is editable.
 */
export const canEdit = (rows: NotificationPathRow[] | null): rows is NotificationPathRow[] =>
  rows !== null;
