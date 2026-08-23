/**
 * How a run's scratch directory is NAMED, and how that name is read back.
 *
 * A leaf module on purpose: `runPayload` creates these directories and must
 * not import anything that touches a database (it runs in a forked worker
 * that has none), while the sweeper that removes them needs a database to
 * decide which are safe to remove. The one thing they must agree on — the
 * name — lives here, so the two can never drift apart.
 */

/** Every scratch directory trawlarr has ever created starts with this. */
export const WORK_DIR_PREFIX = 'trawlarr-job-';

/**
 * Characters allowed in the job id embedded in a directory name.
 *
 * Job ids are `randomUUID()` in every production path, so this only ever
 * rejects something a test or a future caller invented. Anything else is
 * dropped rather than escaped: the name is a path component, and a job id
 * carrying a `/` or a `..` would be a directory somewhere else entirely.
 */
const SAFE_ID = /[^A-Za-z0-9_-]/g;

/**
 * `mkdtemp` prefix for one job's scratch directory: the constant prefix, the
 * job's own id, and a separator for the random suffix `mkdtemp` appends.
 *
 * THE JOB ID IS IN THE NAME SO THE SWEEPER CAN ASK THE DATABASE WHETHER THE
 * DIRECTORY'S OWNER IS STILL RUNNING. Without it a leaked directory is just
 * an anonymous pile of bytes, and the only thing a sweeper could reason
 * about is its age — which is a guess about a live encode, not a fact about
 * it. See `sweepLibraryStaging`.
 *
 * Still `mkdtemp` rather than a plain `mkdir` of the id itself: the atomic
 * "create a directory nobody else has" is what guarantees a run never
 * inherits the contents of an earlier run that used the same id (a retried
 * job in a test, a caller that reuses one), which would put a stale encode
 * where this run's output belongs.
 */
export const workDirPrefix = (jobId: string): string =>
  `${WORK_DIR_PREFIX}${jobId.replace(SAFE_ID, '')}-`;

/**
 * The job id `workDirPrefix` put into `name`, or null when there is none to
 * read: a directory from a build that predates job ids in the name, or one
 * created by a caller that had no job row at all (`trawlarr run --dry-run`).
 *
 * Null is a real answer, not a parse failure, and the sweeper treats it as
 * such — it means "the database cannot tell me who owns this", which is a
 * weaker position than "the database says its owner has finished", and it
 * gets the more conservative rule.
 */
export const jobIdFromWorkDirName = (name: string): string | null => {
  if (!name.startsWith(WORK_DIR_PREFIX)) return null;
  const rest = name.slice(WORK_DIR_PREFIX.length);
  // `mkdtemp` appends exactly six random characters after the prefix, so the
  // id is everything before the final separator. A legacy name is all
  // suffix and no separator, and reads as null.
  const cut = rest.lastIndexOf('-');
  if (cut <= 0) return null;
  return rest.slice(0, cut);
};
