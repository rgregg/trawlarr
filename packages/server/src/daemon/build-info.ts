/**
 * The git commit this build was made from, as the image records it:
 * `TRAWLARR_COMMIT` is baked in by the Dockerfile from a build argument the
 * image workflow sets to the commit it built. Without it, "which code is
 * prod running?" had no answer — every build reported version 0.0.0.
 *
 * `null` for a build that recorded nothing (a source checkout, or a local
 * `docker build` with no `--build-arg`, where the variable is set but empty).
 */
export const buildCommitFrom = (env: Record<string, string | undefined>): string | null => {
  const commit = env.TRAWLARR_COMMIT?.trim() ?? '';
  return commit === '' ? null : commit;
};
