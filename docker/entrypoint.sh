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

MODE="${TRAWLARR_MODE:-server}"
if [ "${MODE}" != "server" ] && [ "${MODE}" != "node" ]; then
  echo "trawlarr: TRAWLARR_MODE=\"${TRAWLARR_MODE}\" must be \"server\" or \"node\"." >&2
  exit 78
fi

# A NODE runs jobs for a server elsewhere: no database, no web UI, no port.
# Selected by environment rather than a different image, so a GPU host runs
# exactly the build its server does. Only the image's own default command
# (`trawlarr daemon`, or none at all) is rewritten — an operator who already
# passed an explicit command gets exactly what they asked for.
if [ "${MODE}" = "node" ] && { [ "$#" -eq 0 ] || [ "${1:-}" = "trawlarr" ]; }; then
  # A node needs no TRAWLARR_NODE_DATA_DIR set on top of TRAWLARR_DATA_DIR:
  # both name the one directory the entrypoint just prepared and chowned.
  export TRAWLARR_NODE_DATA_DIR="${TRAWLARR_NODE_DATA_DIR:-${DATA_DIR}}"
  set -- node /app/dist/cli.js node
fi

exec gosu trawlarr:trawlarr "$@"
