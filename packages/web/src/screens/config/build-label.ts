/**
 * What `GET /system/version` says this daemon is: the version, plus the short
 * commit when the build recorded one. Between releases every build reports
 * the same version, so the commit is what tells two of them apart.
 */
export const buildLabel = (input: { version: string; commit: string | null }): string =>
  input.commit === null ? input.version : `${input.version} (${input.commit.slice(0, 7)})`;
