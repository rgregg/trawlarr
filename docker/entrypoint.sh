#!/bin/bash
# Container entrypoint: align the service user with the host's, prepare the
# state directory, then drop privileges and exec the command.
#
# The uid/gid dance exists because bind-mounted media belongs to a host user
# this image cannot know at build time. Running as root instead would work
# and would leave every replaced file owned by root, which is how a media
# library becomes unmanageable by the tools that filled it.
set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${TRAWLARR_DATA_DIR:-/config}"
ETC_DIR="${TRAWLARR_ETC_DIR:-/etc}"
ZONEINFO_DIR="${TRAWLARR_ZONEINFO_DIR:-/usr/share/zoneinfo}"

# `-o` allows a duplicate id: a host uid that already belongs to another
# container user is normal and is not a reason to fail to start.
groupmod -o -g "${PGID}" trawlarr
usermod -o -u "${PUID}" -g "${PGID}" trawlarr

if [ -n "${TZ:-}" ]; then
  if [ ! -f "${ZONEINFO_DIR}/${TZ}" ]; then
    # Exit 78 (EX_CONFIG). Falling back to UTC would shift every schedule
    # window by hours with nothing anywhere saying why — the exact failure
    # trawlarr's stored schedule timezone exists to prevent.
    echo "trawlarr: TZ=\"${TZ}\" is not a timezone this image knows (looked in ${ZONEINFO_DIR})." >&2
    exit 78
  fi
  cp "${ZONEINFO_DIR}/${TZ}" "${ETC_DIR}/localtime"
  echo "${TZ}" > "${ETC_DIR}/timezone"
fi

# `logs/jobs` is created here rather than lazily, so a wrong PUID surfaces as
# a chown failure at start instead of as a job that cannot write its log an
# hour into a transcode.
mkdir -p "${DATA_DIR}/logs/jobs"
chown -R "${PUID}:${PGID}" "${DATA_DIR}"

exec gosu trawlarr:trawlarr "$@"
