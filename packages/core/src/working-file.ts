/**
 * The prefix of every scratch file trawlarr writes BESIDE library media —
 * as opposed to inside its reserved `.trawlarr` directory, which the walk
 * prunes as a subtree.
 *
 * Two things live under it today, both created by `Replace Original File` in
 * the destination's own directory because they have to be on the
 * destination's filesystem: the `.trawlarr-reserve-<name>` claim on a
 * destination, and the `.trawlarr-replace-<uuid><ext>` copy a cross-device
 * replacement stages before its atomic rename.
 *
 * The name is the contract between the code that writes these files (engine)
 * and the code that must never mistake one for media (the scanner's walk and
 * the watcher), which is why it lives here and both sides import it. When the
 * two agreed only by convention, the staged copy carried a media extension
 * and nothing excluded it: a scan that walked the directory mid-copy opened a
 * row for it, the run then collided with that row recording its own result
 * and was retried against a stale probe — encoding the video twice — and a
 * worker killed mid-copy left a truncated file that was scanned, matched the
 * flow's "already converted" early-out, and was marked good while the real
 * file sat in trash.
 */
export const WORKING_FILE_PREFIX = '.trawlarr-';

/**
 * Is `name` — a single path segment, not a path — one of trawlarr's own
 * scratch files? Such a FILE is never library media, whatever its extension
 * and whether or not any run is still alive to own it. Callers apply this to
 * files only: a directory a user named `.trawlarr-old` is theirs.
 */
export const isWorkingFileName = (name: string): boolean => name.startsWith(WORKING_FILE_PREFIX);
