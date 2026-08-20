# Deploying trawlarr with Docker

Trawlarr ships as one image. It contains the daemon, the `trawlarr` CLI (which
becomes that daemon's API client inside the same container), and `ffmpeg` /
`ffprobe` — without those two the daemon can probe nothing and transcode
nothing, so they are part of the image rather than something you mount in.

The same image is used for a CPU-only deployment and for an NVIDIA one; only
the compose file differs.

## 1. Quick start

```bash
git clone https://github.com/rgregg/trawlarr
cd trawlarr

# Point the library bind mount at your media, then:
docker compose -f docker/compose.yml up -d
docker logs trawlarr
```

The first start mints an API key and prints it **once**:

```
trawlarr daemon listening on http://0.0.0.0:8265/api/v1 (data directory /config).
  API key (generated on this first run, stored from now on): <key>
```

It is stored in `/config/trawlarr.db` from that moment on and never printed
again — a daemon that reprinted it on every start would be spraying a live
credential into every log that captures stdout. If you would rather know the
key in advance, set `TRAWLARR_API_KEY` in the compose file before the first
start (minimum 16 characters).

There is no web UI in this build: `GET /` answers `404` and says so
(`No route for GET /. Every endpoint lives under /api/v1`). Everything is the
REST API — or, more simply, the CLI **inside** the container, which needs no
key at all because it reads the daemon's own lock file:

```bash
docker exec trawlarr trawlarr status
docker exec trawlarr trawlarr library add --name Movies --root /library
docker exec trawlarr trawlarr flow add --name HEVC --file /config/flow.json
docker exec trawlarr trawlarr library set-flow --library Movies --flow HEVC
```

From there the daemon scans, queues and converges on its own — you do not need
to run `scan` or `run` by hand.

A flow is a JSON file. This one — everything to HEVC, verified, then the
original replaced — is the whole of a working first deployment; drop it in
`./config/flow.json` (which is `/config/flow.json` inside the container):

```json
{
  "nodes": [
    { "id": "start", "pluginId": "trawlarr:start", "pluginVersion": "1.0.0", "inputs": {} },
    { "id": "check", "pluginId": "trawlarr:checkVideoCodec", "pluginVersion": "1.0.0", "inputs": { "codec": "hevc" } },
    { "id": "begin", "pluginId": "trawlarr:beginCommand", "pluginVersion": "1.0.0", "inputs": {} },
    { "id": "encoder", "pluginId": "trawlarr:setVideoEncoder", "pluginVersion": "1.0.0", "inputs": { "encoder": "libx265", "quality": "28" } },
    { "id": "execute", "pluginId": "trawlarr:execute", "pluginVersion": "1.0.0", "inputs": {} },
    { "id": "verify", "pluginId": "trawlarr:verifyOutput", "pluginVersion": "1.0.0", "inputs": { "durationToleranceSeconds": "1", "minSizeRatio": "0.05" } },
    { "id": "replace", "pluginId": "trawlarr:replaceOriginal", "pluginVersion": "1.0.0", "inputs": { "trashRetentionDays": "14", "allowCrossDevice": "false" } }
  ],
  "edges": [
    { "fromNodeId": "start", "outputNumber": 1, "toNodeId": "check" },
    { "fromNodeId": "check", "outputNumber": 2, "toNodeId": "begin" },
    { "fromNodeId": "begin", "outputNumber": 1, "toNodeId": "encoder" },
    { "fromNodeId": "encoder", "outputNumber": 1, "toNodeId": "execute" },
    { "fromNodeId": "execute", "outputNumber": 1, "toNodeId": "verify" },
    { "fromNodeId": "verify", "outputNumber": 1, "toNodeId": "replace" }
  ]
}
```

`check` output 1 is "already HEVC" and is routed nowhere, which is how a
converged file costs nothing: the flow ends immediately. Output 2 is "differs",
and is what runs the encode. `allowCrossDevice: "false"` is deliberate — see
§3.

## 2. Volumes

| Container path | What it is                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `/config`      | All state: `trawlarr.db` (SQLite), `daemon.json` (the running daemon's lock record), and `logs/jobs/`, which the entrypoint creates so that a wrong `PUID` fails at start rather than an hour into a transcode. (Per-job log *files* are not written yet; each step's log excerpt is on `GET /api/v1/jobs/:id`, and live lines are pushed on the WebSocket.) |
| `/library`     | Your media. Bind-mount the real directory; mount as many as you like and add each as a library root.            |

`/config` is the whole backup. Stop the container, copy the directory, start it
again — copying a live SQLite database from a running container gives you a
file that may not open. There is nothing else to back up: flows, libraries,
settings and the convergence ledger all live in there.

The container writes `/config` as `PUID:PGID` (see §6). It **never** chowns
your library.

### Two containers, one `/config`, is a configuration error

The daemon takes an exclusive lock on its data directory and refuses to start
if another live daemon holds it:

```
A trawlarr daemon (pid N) already owns this data directory and is serving its
API on 0.0.0.0:8265. Only one daemon may own a data directory: two of them
would each hold the same SQLite file open, claim the same queued files, and
start two workers on one media file — which is how a replacement destroys
data. Stop that daemon first, or point this one at a different --data-dir.
```

That is the designed behaviour, not a bug: it fails loudly instead of quietly
corrupting. If you want a second instance, give it a second `/config`. If you
want more throughput, raise `NUMBER_OF_WORKERS` on the one you have.

### After an unclean stop, clear the lock

A clean `docker stop` removes the lock (`SIGTERM` reaches the daemon as PID 1,
it drains, and it deletes `/config/daemon.json`). A container that is *killed*
— `docker kill`, an OOM kill, a host that lost power — cannot, and leaves the
record behind.

Normally a stale lock is reclaimed automatically, by checking whether the pid
in it is still alive. **Inside a container that check cannot work**, because
the daemon is always pid 1: the record says `"pid": 1`, and the replacement
container's own pid 1 is very much alive, so the new daemon concludes another
daemon owns the directory and refuses to start — for ever, restarting into the
same message every few seconds.

The recovery is one command, once you have confirmed no trawlarr container is
running:

```bash
docker compose -f docker/compose.yml down
rm ./config/daemon.json
docker compose -f docker/compose.yml up -d
```

Deleting that file while a daemon really is running would let a second one in,
which is the situation the lock exists to prevent — so check first.

## 3. The staging trap — read this before you translate an Unmanic compose file

Trawlarr does its work **inside the library it is working on**. Each job's
in-progress transcode is written to `<library root>/.trawlarr/staging`, and
each replaced original is moved to `<library root>/.trawlarr/trash`. Both are
deliberately inside the library, because installing a finished file must be an
atomic rename and a rename cannot cross filesystems.

If you come from Unmanic and are used to pointing a cache directory at a
separate disk, **do not do that here.** A `stagingDir` on a different
filesystem degrades every replacement from a rename into a full copy of the
finished encode — slower, and with a much wider window in which a crash or a
power cut leaves a partial file where your movie used to be. Trawlarr does not
silently degrade: with `allowCrossDevice` off, Replace Original File refuses
and says so by name —

```
Replacement refused: Configured staging directory "/tmp/trawlarr-job-Kq3gm4" is
on a different filesystem than "/library/movie1.mkv". Replacement requires an
atomic rename, which cannot cross devices; point stagingDir at a directory on
the same filesystem as the library root, or unset it to use the per-root
default.
```

This is why `docker/compose.yml` has **no cache or staging volume**, and why
adding one is not an optimisation. The defaults are correct by construction:
leave `stagingDir` and `trashDir` unset and every job stages beside the file it
is about to replace — per root, so a multi-root library spanning several disks
still stages on the right one. The scanner excludes the whole `.trawlarr`
directory from its walk, so nothing it writes is ever ingested as media.

The two rules that follow:

- Keep free space **inside** each library root — roughly the size of the
  largest file you transcode, times `NUMBER_OF_WORKERS`. Work does not spill
  onto some other disk, and in particular **it does not fill the container's
  own writable layer**.
- If your media is spread across several filesystems, give each one its own
  library root (or its own library). Each root gets its own `.trawlarr`.

Trawlarr *can* be told to accept a cross-device staging directory
(`allowCrossDevice` on the Replace Original File node, plus an explicit
`stagingDir` on the library), and the replace step then falls back to
copy-then-exclusive-create with the same verification. It is a deliberate
escape hatch for the one deployment that genuinely needs it — not a default,
and not a speed-up.

## 4. Environment variables

Two kinds, and the difference matters.

**Seeds** — read on start, written to the database **only if nothing has ever
set that setting**. After that the stored value wins, so a value you change in
the UI is not silently reverted by your compose file on the next restart. An
invalid value is recorded and skipped rather than refusing to start: one
mistyped optional variable should not take a media server offline.

**Per-run overrides** — read on every start, never stored.

| Variable                     | Seeds / overrides                | Meaning                                                                                                                                          |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TZ`                         | `schedule.timezone` (seed)       | The timezone schedule windows are evaluated in. Deliberately a stored setting rather than the host clock, so a container with `TZ` unset does not shift every window. The entrypoint also writes the container's own `/etc/localtime` from it, and **exits 78 if the zone is unknown** rather than silently falling back to UTC. |
| `NUMBER_OF_WORKERS`          | `schedule.baseCounts.transcode` (seed) | How many transcode workers run when no schedule window says otherwise.                                                                     |
| `SCHEDULE_FULL_SCAN_MINUTES` | `scan.rescanIntervalMs` (seed)   | Minutes between periodic full rescans. This is the correctness backstop for network mounts, where filesystem watch events are dropped.              |
| `RUN_FULL_SCAN_ON_START`     | `scan.scanOnStart` (seed)        | Whether every enabled library is walked when the daemon starts.                                                                                    |
| `TRAWLARR_API_KEY`           | `daemon.apiKey` (seed)           | The API key clients send as `X-Api-Key`. Set it to know it in advance; leave it unset and one is generated and printed on the first run only. Minimum 16 characters. |
| `TRAWLARR_HARDWARE`          | `hardware.available` (seed)      | Which hardware this node **declares** it has, comma-separated (e.g. `cpu,nvenc`). See §5.                                                          |
| `TRAWLARR_HARDWARE_CAPS`     | `hardware.caps` (seed)           | Concurrency cap per hardware type, e.g. `nvenc=2` for a consumer NVIDIA card whose NVENC session limit fails jobs rather than queueing them.        |
| `TRAWLARR_PORT`              | `daemon.port` (this run only)    | Same meaning as `trawlarr daemon --port`. Not stored.                                                                                              |
| `TRAWLARR_BIND`              | `daemon.bind` (this run only)    | Same meaning as `trawlarr daemon --bind`. Not stored. **The image sets this to `0.0.0.0`** — see §7.                                                |
| `TRAWLARR_DATA_DIR`          | `--data-dir` (this run only)     | Default for every command's `--data-dir`. The image sets it to `/config`. Not stored.                                                              |
| `PUID` / `PGID`              | read by the entrypoint           | The uid/gid the daemon runs as. See §6.                                                                                                            |

You never have to guess whether a variable did anything.
`GET /api/v1/system/settings` reports, for every variable you set, whether it
was applied (`seeded`, `ignored-already-set`, `invalid`) and whether the live
value still matches it:

```json
{ "name": "NUMBER_OF_WORKERS", "target": "schedule.baseCounts.transcode",
  "envValue": "2", "applied": "ignored-already-set", "problem": null,
  "currentValue": "2", "matchesEnv": true }
```

`TRAWLARR_API_KEY` is the one exception: its `envValue` and `currentValue` are
both reported as `(redacted)` in that list. (The live key itself is still in
the response, under `daemon.apiKey` — that endpoint needs the key to call, so
it is the way to recover a key you failed to write down, not a leak.)

## 5. Hardware is declared, never detected

Trawlarr does not probe the machine for encoders. `TRAWLARR_HARDWARE=nvenc` on
a host without a working NVENC device does not fall back to software — it
produces failing jobs, because the ffmpeg invocation the flow built asks for an
encoder that is not there.

Declare only what you have:

- CPU-only host: leave `TRAWLARR_HARDWARE` unset, or set `cpu`.
- NVIDIA host: you need the NVIDIA container runtime and a compose file that
  requests the GPU **as well as** `TRAWLARR_HARDWARE=nvenc`. The image already
  contains an `ffmpeg` with `h264_nvenc`/`hevc_nvenc` compiled in; the driver
  libraries are injected at run time by the runtime, not baked in.

To see what the image's ffmpeg can actually do on your host:

```bash
docker exec trawlarr ffmpeg -hide_banner -encoders | grep nvenc
```

That lists what ffmpeg was **built** with. Whether a given encoder *works* is
decided by the device and driver visible to the container.

## 6. Users and permissions

`PUID`/`PGID` must match the owner of your media. The entrypoint renumbers the
in-image `trawlarr` user to those ids, chowns **only** `/config`, and then
`exec`s the daemon through `gosu`, so PID 1 is the daemon itself and `SIGTERM`
from `docker stop` reaches it — in-flight work is drained, not killed.

It deliberately does **not** chown your library. A tool that recursively
rewrote ownership of a media tree because a compose file had a typo would be
doing far more damage than it fixed.

Get this wrong and the symptom is specific: trawlarr reads and probes files
fine, then every replacement fails, because reading a file needs `r` on the
file and replacing it needs `w` **on its directory**. Check with:

```bash
docker exec trawlarr id
stat -c '%u:%g' /srv/media/some-movie.mkv
```

Files trawlarr creates are owned by `PUID:PGID`. Their **mode** is the
daemon's, not the original's — a `0664` file replaced by trawlarr comes back
`0644` under the default umask — so if something else in your stack needs group
write on the media, give the container a umask
(`user: "1000:1000"` plus your own wrapper, or fix the group bits afterwards)
rather than assuming the old bits survive.

## 7. Ports and exposure

The daemon binds `127.0.0.1` by default. That is the right default for a
process on a shared machine and the wrong one inside a container, where
`127.0.0.1` is the container's own loopback and a published port would answer
nothing at all. **The image therefore sets `TRAWLARR_BIND=0.0.0.0`** — in the
image, not in the code, because the boundary here is the container's network
namespace plus your `ports:` mapping, and those are the operator's to choose.

Which means the exposure decision is the `ports:` line, and it is yours:

```yaml
ports:
  - '8265:8265' # reachable from your LAN
  - '127.0.0.1:8265:8265' # reachable only from the Docker host
```

The API speaks **plain HTTP** and authenticates with a single shared key sent
as `X-Api-Key`. There is no TLS and no user model. If it is reachable from
anywhere you do not fully trust, put a reverse proxy in front of it and
terminate TLS there.

`GET /api/v1/system/health` is the one route that needs no key — precisely so
that the image's `HEALTHCHECK` (and yours, and your monitoring) needs no
secret. Everything else 401s without the key.

## 8. Hardlinked files are skipped by default

**If trawlarr appears to do nothing at all with a library fed by a torrent
client, this is almost certainly why.** It is the single most likely reason a
working install looks broken to this audience.

A file with more than one link is tracked but never queued. It is not probed,
no job is ever created for it, and it sits in state `unknown` with `attempts
0`, for ever:

```
$ docker exec trawlarr trawlarr status --library Movies --files
Movies: 4 file(s) — good 3, queued 0, held 0, running 0, failed 0, not_converging 0, unknown 1 (75% converged)
  ...
  415bc7d6-b14c-4b5a-a78b-724de04d597b  unknown         attempts 0  /library/torrented.mkv
```

Every scan says how many it passed over:

```
$ docker exec trawlarr trawlarr scan --library Movies
... 1 skipped (hardlinked), 0 unreadable/conflicted.
```

This is the normal shape of an *arr* setup: qBittorrent's download directory
and your library are two names for one inode, which is what makes the import
instant and the seeding copy free. Replacing such a file would either break
that link or mutate the copy you are still seeding, so trawlarr declines to
decide that for you.

Your options, in the order most people want them:

1. **Leave it as it is** and let those files converge once they stop seeding
   and the download copy is removed. `nlink` drops back to 1, the next scan
   probes and queues them, and nothing else is needed from you.
2. **Turn it off deliberately, per library.** `--allow-hardlinked` on
   `trawlarr library add`, or on a library that already exists:

   ```bash
   curl -fsS -X PATCH -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"allowHardlinked":true}' http://localhost:8265/api/v1/libraries/<id>
   docker exec trawlarr trawlarr scan --library Movies
   ```

   The next scan probes and queues them. No `requeue` is needed: these files
   were never failed, only never started.

   What then happens to the other name is worth being precise about, because
   it is not what most people expect. The replacement is a *new* file at the
   library path; the original is moved (not copied) into
   `<root>/.trawlarr/trash`. So your torrent client's copy is not modified and
   not deleted — it now shares its inode with the trashed original, and goes
   on seeding the old content until the trash retention sweep removes it.
   Budget the disk for that, and know that the two names have parted company.

There is a second guard behind this one, in Replace Original File itself, for a
file that acquires a link between the scan and the run. It refuses **before
anything moves**, so the original is never at risk:

```
Replacement refused: "/library/Movie.mkv" is hardlinked (2 links). Replacing it
would leave the other names pointing at the old content, so this library's
"allow hardlinked" setting must be turned on to do it deliberately.
```

That refusal does cost the file an attempt: it is `held` with a backoff, and
after three attempts `failed`, which is terminal and needs
`trawlarr requeue --library Movies --state failed`.

## 9. Upgrading

```bash
docker compose -f docker/compose.yml pull
docker compose -f docker/compose.yml up -d
```

`docker stop` sends `SIGTERM` to the daemon, which drains in-flight work rather
than killing it, so an upgrade during a transcode does not leave debris.
Database migrations are forward-only and run on start. Back up `/config`
(container stopped) before a major-version upgrade.

## 10. Licensing of the image

Trawlarr's own code is **MIT** — see [`LICENSE`](../LICENSE).

The image is an *aggregation*, not a derivative work: on top of the official
`node:22-bookworm-slim` base it installs the Debian packages `ffmpeg`, `gosu`,
`tzdata` and `ca-certificates` from Debian bookworm, each under its own
licence. Trawlarr executes `ffmpeg` as a **separate process** over its
command-line interface; it does not link against libavcodec or any other
ffmpeg library, and no ffmpeg code is copied into trawlarr's sources.

What that ffmpeg is licensed as is decided by how Debian built it, not by this
project. Debian's `ffmpeg` package for bookworm is built **GPL-2.0+/GPL-3.0+**
(it enables GPL-licensed components such as `libx264` and `libx265`), and it is
built **without** `--enable-nonfree`, so it is redistributable. The exact terms
of the copy you are running are in the image itself:

```bash
docker run --rm --entrypoint ffmpeg ghcr.io/rgregg/trawlarr:latest -hide_banner -version | head -3
docker run --rm --entrypoint cat ghcr.io/rgregg/trawlarr:latest /usr/share/doc/ffmpeg/copyright
```

If your deployment needs an LGPL-only or otherwise differently-licensed ffmpeg,
build an image `FROM ghcr.io/rgregg/trawlarr:latest` that replaces the binaries
and point `binaries.ffmpeg` / `binaries.ffprobe` at them — trawlarr resolves
both by bare name on `PATH` by default, so a drop-in replacement needs no
configuration at all.

## 11. Troubleshooting

| Symptom                                              | Cause                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Container exits immediately, code **78**             | `TZ` names a zone the image does not know. Use an IANA name, e.g. `America/Los_Angeles`.                                       |
| Container exits, "already owns this data directory" | Either two containers really do share one `/config` (give the second its own), or a killed container left a stale `/config/daemon.json` behind. See §2. |
| Nothing is ever queued                                | The library has no flow (`library set-flow`), is paused because its flow is invalid (`trawlarr status` says so), or is empty. |
| Files sit at `unknown` with `attempts 0`, nothing is queued | Hardlinks — the scanner skipped them. See §8.                                                                            |
| Files probe fine but every replacement fails          | `PUID`/`PGID` do not own the *directory*. See §6.                                                                            |
| Every job fails immediately on an NVIDIA host         | `TRAWLARR_HARDWARE=nvenc` declared without the GPU actually reaching the container. See §5.                                    |
| Replacements are slow and the disk churns             | A `stagingDir` was pointed at another filesystem. See §3.                                                                    |
| `docker logs` no longer shows the API key             | By design; it is printed only on the run that minted it. Read it from `GET /api/v1/system/settings`, or set it explicitly.    |
