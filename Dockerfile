# syntax=docker/dockerfile:1

# One image for every deployment. The NVIDIA compose file runs THIS image:
# Debian's ffmpeg already carries h264_nvenc/hevc_nvenc, and the NVIDIA
# container runtime injects the driver at run time, so a second Dockerfile
# would be a second thing to maintain that differs in nothing that matters.
#
# The base is pinned by digest, not just by tag: `node:22-bookworm-slim`
# moves, and an image that rebuilds differently tomorrow cannot be bisected.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# ---- build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable

# better-sqlite3 is a native module: it needs a toolchain to build here, and
# none at run time, which is the whole reason this stage exists.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Manifests first, and only manifests: `pnpm install` is re-run when a
# dependency changes and NOT when a source file does.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/plugins-core/package.json packages/plugins-core/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
 && pnpm deploy --filter @trawlarr/server --prod /out

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="trawlarr" \
      org.opencontainers.image.description="Media library transformation engine" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/rgregg/trawlarr"

# ffmpeg and ffprobe are third-party binaries under their own licences,
# aggregated into this image and not linked into or derived from trawlarr's
# own MIT-licensed code. gosu drops privileges without the signal-forwarding
# problems `su` has as PID 1's child.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg gosu tzdata ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    # The base image already ships a `node` user at uid/gid 1000, which is the
    # id a NAS user most often has. It is removed rather than reused, so that
    # `id` inside the container names one identity and the entrypoint's
    # `usermod`/`groupmod` have exactly one row to renumber.
    userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    rm -rf /home/node; \
    groupadd -g 1000 trawlarr; \
    useradd -u 1000 -g 1000 -d /config -s /usr/sbin/nologin trawlarr; \
    # Asserted at build time: a base image that changed its own users must
    # break the build, not produce an image whose uid 1000 is somebody else.
    [ "$(id -un 1000)" = trawlarr ]

# The base image ships /etc/localtime as a SYMLINK into /usr/share/zoneinfo
# (Etc/UTC). The entrypoint writes the zone by copying the zoneinfo file over
# /etc/localtime, and `cp a a` fails with "are the same file" — so with the
# compose file's own default of TZ=Etc/UTC, `set -e` would abort the
# entrypoint and the container would crash-loop before the daemon ever ran.
# Materialising it as a regular file makes that copy an ordinary overwrite for
# every zone, including the one it already points at.
RUN cp --remove-destination /usr/share/zoneinfo/Etc/UTC /etc/localtime

COPY --from=build /out /app
COPY docker/entrypoint.sh /entrypoint.sh
# `tsc` emits the CLI 0644, so the shebang alone is not enough: exec would
# skip a non-executable file and the ENTRYPOINT's `gosu trawlarr` would fail
# with "executable file not found in $PATH". `isMain()` resolves argv[1]
# through `realpathSync`, which is why running it via this symlink works and
# `docker exec <container> trawlarr status` is how an operator reads state.
RUN chmod +x /entrypoint.sh /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/trawlarr

# TRAWLARR_BIND=0.0.0.0 is set HERE and not in the daemon's defaults. The
# daemon binds 127.0.0.1 on a host because that is the safe default for a
# process on a shared machine; inside a container 127.0.0.1 is the container's
# own loopback, so a published port would answer nothing at all. The network
# boundary here is the container's namespace and the operator's `ports:`
# mapping, which is why widening the bind is correct in the image and would
# not be correct in the code.
ENV TRAWLARR_DATA_DIR=/config \
    TRAWLARR_BIND=0.0.0.0 \
    NODE_ENV=production
VOLUME ["/config"]
EXPOSE 8265

# The health endpoint is the ONLY anonymous route, precisely so a health
# check needs no API key.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8265/api/v1/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["trawlarr", "daemon"]
