# Migrating from Unmanic

This guide is for someone who already runs Unmanic against a real media
library and wants to run trawlarr against that same library instead. It
assumes you know your own Unmanic setup; it does not assume you know
trawlarr's.

Everything below was executed against the image in this repository before it
was written, and the terminal output quoted in §3 is that run's real output,
not an illustration.

---

## 0. First: do not run both against the same files

**This is the only step in this guide that can lose data, and it is step
zero.**

Unmanic and trawlarr both *replace* files in place. Two tools replacing the
same files at once is the real migration risk: Unmanic can finish a transcode
and swap a file out from under a trawlarr job that is halfway through reading
it, and trawlarr can do the same to Unmanic. Neither knows the other exists —
there is no lock they share, and no error message either of them can print
that names the other one. The symptom is a file that fails verification, or a
file that quietly ends up being the *older* of two encodes.

Pick one of these two before you go any further:

**A. Stop Unmanic first (recommended, and what most people want).**

```bash
docker compose -f /path/to/unmanic/docker-compose.yml down
```

Leave it stopped, and leave its `/config` on disk. Nothing in this guide reads
it, and keeping it means going back is `docker compose up -d` and nothing
else. Trawlarr never writes to Unmanic's config directory or its cache
directory.

**B. Run side by side, against a copy.**

Do this if you want to compare results before committing. Copy a *small*
subset of the library — one season, a handful of films — to a directory
neither Unmanic nor your \*arr stack is pointed at, and give trawlarr only
that:

```bash
mkdir -p /srv/media-trawlarr-trial
cp /srv/media/tv/SomeShow/Season\ 01/*.mkv /srv/media-trawlarr-trial/
```

`cp`, not `mv`, and not `ln`: a hardlink would put both tools back on the same
inode, which is the thing you were trying to avoid. (It would also be skipped
— see §5.)

What you must **not** do is point trawlarr's `/library` at your live library
while Unmanic is still running against it, even with a small number of
workers, even overnight.

---

## 1. What is the same

More than you would expect. Trawlarr deliberately uses the same variable names
Unmanic and Tdarr use, so most of your compose file translates by changing the
image and deleting things.

<table>
<tr><th>Unmanic</th><th>Trawlarr</th></tr>
<tr><td>

```yaml
services:
  unmanic:
    image: josh5/unmanic:latest
    container_name: unmanic
    restart: unless-stopped
    ports:
      - '8888:8888'
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/Los_Angeles
      - NUMBER_OF_WORKERS=2
      - SCHEDULE_FULL_SCAN_MINUTES=60
      - RUN_FULL_SCAN_ON_START=true
    volumes:
      - ./config:/config
      - /srv/media:/library
      - /mnt/cache/unmanic:/tmp/unmanic
```

</td><td>

```yaml
services:
  trawlarr:
    image: ghcr.io/rgregg/trawlarr:latest
    container_name: trawlarr
    restart: unless-stopped
    ports:
      - '8265:8265'
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/Los_Angeles
      - NUMBER_OF_WORKERS=2
      - SCHEDULE_FULL_SCAN_MINUTES=60
      - RUN_FULL_SCAN_ON_START=true
      - TRAWLARR_HARDWARE=cpu
    volumes:
      - ./config:/config
      - /srv/media:/library
```

</td></tr>
</table>

Item by item:

| | |
| --- | --- |
| `PUID` / `PGID` | Same meaning, same failure mode if wrong. The entrypoint renumbers the in-image user to these ids, chowns **only** `/config`, and never touches your library. |
| `TZ` | Same, and it is what schedule windows are evaluated in. An unknown zone **exits 78** at start rather than silently falling back to UTC. |
| `/config` | Same idea: all state lives there. For trawlarr that is one SQLite database plus the daemon's lock file. It is the whole backup. |
| A bind-mounted library | Same. Mount as many as you like and add each as a library root. |
| `NUMBER_OF_WORKERS` | Same meaning: how many transcode workers run when no schedule window says otherwise. |
| `SCHEDULE_FULL_SCAN_MINUTES` | Same meaning: minutes between periodic full rescans. |
| `RUN_FULL_SCAN_ON_START` | Same meaning: walk every enabled library when the daemon starts. |
| `ports:` | Different number (8265, Tdarr's), same decision — and it is yours. The API is plain HTTP with one shared key; put a proxy in front of it if it leaves your LAN. |

And the NVIDIA variant, which if you have an NVENC Unmanic container is the
one you actually run:

```yaml
services:
  trawlarr:
    image: ghcr.io/rgregg/trawlarr:latest
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
      - TRAWLARR_HARDWARE=cpu,nvenc
      - TRAWLARR_HARDWARE_CAPS=nvenc=2
```

`runtime: nvidia` and `NVIDIA_VISIBLE_DEVICES` carry over from your Unmanic
compose file unchanged. Two lines are new and both matter:

- **`NVIDIA_DRIVER_CAPABILITIES` must include `video`.** The runtime's default
  is `compute,utility`, which injects CUDA and `nvidia-smi` but **not**
  `libnvidia-encode`. `nvidia-smi` then works inside the container, which is
  exactly why this is so confusing, and every NVENC transcode fails.
- **`TRAWLARR_HARDWARE=nvenc` is an assertion you are making, not something
  trawlarr detected.** See §2.4 — read it before your first NVENC run, not
  after.

Ready-made compose files for both shapes are in
[`docker/compose.yml`](../docker/compose.yml) and
[`docker/compose.nvidia.yml`](../docker/compose.nvidia.yml).

---

## 2. What is different, and why

### 2.1 There is no cache mount. Delete it; do not translate it.

Your Unmanic compose file almost certainly has a cache directory, and it is
very likely on a different disk from the library — an SSD in front of a spinning
array, which is exactly the right thing to do in Unmanic.

**Do not do that here.** Trawlarr writes each job's in-progress transcode to
`<library root>/.trawlarr/staging` and moves each replaced original to
`<library root>/.trawlarr/trash`, both deliberately *inside the library*,
because installing a finished file must be an **atomic rename** and a rename
cannot cross filesystems.

Point staging at another filesystem and every replacement degrades from a
rename into a full copy of the finished encode: slower, and with a much wider
window in which a crash or a power cut leaves a partial file where your film
used to be. Trawlarr does not degrade silently — with `allowCrossDevice` off,
Replace Original File refuses by name:

```
Replacement refused: Configured staging directory "/tmp/trawlarr-job-Kq3gm4" is
on a different filesystem than "/library/movie1.mkv". Replacement requires an
atomic rename, which cannot cross devices; point stagingDir at a directory on
the same filesystem as the library root, or unset it to use the per-root
default.
```

So the translation of your cache volume is: **delete the line.** The defaults
are correct by construction — leave `stagingDir` and `trashDir` unset and every
job stages beside the file it is about to replace, per root, so a library
spanning several disks still stages on the right one. The scanner excludes the
whole `.trawlarr` directory from its walk, so nothing it writes is ever
ingested as media.

Two consequences to plan for:

- Keep free space **inside** each library root — roughly the size of your
  largest file, times `NUMBER_OF_WORKERS`. Work does not spill onto another
  disk, and in particular it does not fill the container's writable layer.
- If your media spans several filesystems, give each one its own library root
  (or its own library). Each root gets its own `.trawlarr`.

There *is* an escape hatch (`allowCrossDevice` on the node, plus an explicit
`stagingDir`), and the replace step then falls back to copy-then-atomic-rename
with the same verification. It is for the one deployment that genuinely needs
it. It is not a speed-up, and it is not what your Unmanic cache mount was.

### 2.2 A flow, not a plugin list

Unmanic runs an ordered plugin stack against each file, and a plugin decides
to do nothing by returning early. Trawlarr walks a **graph** and takes a
branch.

The practical difference: "only process files that are not already HEVC" is
not a setting and not a plugin that opts out — it is an explicit branch node
with two outputs, and the "already HEVC" output is **left connected to
nothing**. That dead end is not an oversight; it is how a converged file costs
nothing. Route it somewhere that leads back to the encoder and you have built
a machine that re-encodes your library for ever.

You do not have to draw this yourself. §3 builds it from a template.

### 2.3 Convergence, not a queue

Unmanic thinks in terms of a task queue you can refill. Trawlarr thinks in
terms of a **signature**: for each file it records what the file was and which
version of which flow was applied, and when those agree it stops. A file in
state `good` costs nothing on every subsequent scan for ever.

So there is no "reprocess everything" button, and there does not need to be.
Edit the flow and its hash changes, which makes every file's recorded
signature stale, which re-queues exactly the affected files — automatically,
at the next scan. That is the whole mechanism.

What this changes for you day to day: `trawlarr status` reports a percentage
converged rather than a queue depth, and "the queue is empty" and "the library
is done" are the same statement.

### 2.4 Hardware is declared, never detected

`TRAWLARR_HARDWARE=nvenc` does not ask your machine anything. It is a claim
you are making. A wrong claim does **not** fall back to software — it produces
failing jobs, three attempts per file, because the ffmpeg command the flow
built names an encoder that is not there.

Trawlarr checks the claim once at every start (it asks ffmpeg what it was
built with, and for `nvenc` actually encodes a single 64×64 frame to
`/dev/null`) and, if it does not hold, says so by name — once, and then
carries on exactly as you told it to:

```
[trawlarr] hardware.available declares "nvenc", but ffmpeg at "ffmpeg" could not
encode a single frame with "hevc_nvenc" on this machine. Nothing has been changed
for you — the declaration stands, so every job a flow routes to that hardware will
be attempted and will fail, three attempts each, one file at a time. ...
```

**Read that line on your first start.** It is one line, it appears once, and it
scrolls away. The same finding is on the API, where an **empty array is the
healthy answer** — this is the thing to assert, not to eyeball:

```bash
curl -fsS -H "X-Api-Key: $KEY" http://localhost:8265/api/v1/system/version | jq .hardware
[]
```

If it is not empty, the daemon already explained it at start:
`docker logs trawlarr | grep hardware.available`.

`TRAWLARR_HARDWARE_CAPS=nvenc=2` is a separate promise: how many jobs may use
that hardware at once. Consumer GeForce cards cap concurrent NVENC sessions
and **fail** the extra session rather than queueing it, so set this to your
card's real limit and the supervisor will hold the job in the queue instead of
burning an attempt on it.

### 2.5 Replacement is a node you can see

Nothing is replaced implicitly. If your flow has no `Replace Original File`
node, trawlarr transcodes into staging and then throws the result away. That
is a legitimate dry-run shape — and it is also the most common first mistake,
so it is worth knowing which one you have built.

The template in §3 includes the node. If you hand-author a flow, look for it.

---

## 3. Step by step

This is the whole migration, and the output below is from actually running it.
The environment: Docker 29.5.2, a three-file fixture library, the image built
from this repository and tagged `trawlarr:task6` (substitute
`ghcr.io/rgregg/trawlarr:latest`), published on 8266 to keep it off the real
port.

Every step is given as the **CLI inside the container**, which needs no API
key at all because it reads the daemon's own lock file, and as the equivalent
`curl` — because the API has no privileged path the CLI does not, and that is
worth demonstrating.

### 3.1 Write the compose file and start

```yaml
services:
  trawlarr:
    image: ghcr.io/rgregg/trawlarr:latest
    container_name: trawlarr
    restart: unless-stopped
    ports:
      - '8265:8265'
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/Los_Angeles
      - NUMBER_OF_WORKERS=2
      - SCHEDULE_FULL_SCAN_MINUTES=60
      - RUN_FULL_SCAN_ON_START=true
      - TRAWLARR_HARDWARE=cpu
    volumes:
      - ./config:/config
      - /srv/media:/library
```

Note what is **not** there: no cache volume (§2.1).

```
$ docker compose -f compose.yml up -d
Container trawlarr-lab Creating
Container trawlarr-lab Created
Container trawlarr-lab Starting
Container trawlarr-lab Started
```

### 3.2 Read the API key from the logs — it is printed once

```
$ docker logs trawlarr-lab
usermod: no changes
trawlarr daemon listening on http://0.0.0.0:8265/api/v1 (data directory /config).
  API key (generated on this first run, stored from now on): 0b340568d67d9122778df4e7fc616949bcc70c1df2e44bd2
  The API binds 0.0.0.0 by default and speaks plain HTTP: put a reverse proxy in front of it if it needs to be reachable from anywhere else. While this daemon is running it owns the data directory, and "trawlarr" commands in other terminals talk to it rather than opening the database. Stop it with Ctrl-C: work already in progress is drained, not killed.
```

Write it down. It is never printed again — a daemon that reprinted a live
credential on every start would be spraying it into every log that captures
stdout. (You can set `TRAWLARR_API_KEY` in the compose file *before* the first
start to know it in advance, and you can always recover it from
`GET /api/v1/system/settings`.)

**This is also where you check the hardware declaration you made (§2.4).**
There is no warning line above, and the API agrees — an empty array is the
healthy answer:

```
$ curl -fsS -H "X-Api-Key: $KEY" http://localhost:8266/api/v1/system/version | jq .hardware
[]
```

### 3.3 Add the library

```
$ docker exec trawlarr-lab trawlarr library add --name Movies --root /library
Added library "Movies" (0f967390-33d5-4917-a4bb-4aea5567946d) with 1 root(s): /library
```

Equivalent:

```bash
curl -fsS -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Movies","roots":["/library"]}' \
  http://localhost:8265/api/v1/libraries
```

### 3.4 Create the flow from a template

This is the step that replaces "install and order your Unmanic plugins". List
what is on offer:

```
$ curl -fsS -H "X-Api-Key: $KEY" http://localhost:8266/api/v1/flows/templates | jq -r '.[] | .id + "  " + .name'
transcode-hevc   Transcode video to a target codec
```

`GET /api/v1/flows/templates` also returns each parameter with its default,
its allowed values and a tooltip explaining what getting it wrong costs, which
is what a UI renders as a form.

Then build one. `--set` takes any of those parameter names; anything you leave
out uses the template's default:

```
$ docker exec trawlarr-lab trawlarr flow add --name "Movies HEVC" --template transcode-hevc --set encoder=libx265 --set quality=24
Added flow "Movies HEVC" (52b94889-570d-4940-9e5b-304e1dd2a386), 7 node(s).
```

On an NVENC host that one command becomes:

```bash
docker exec trawlarr trawlarr flow add --name "Movies HEVC" \
  --template transcode-hevc --set encoder=hevc_nvenc --set quality=22
```

Equivalent over the API — send the template, not a definition, and the daemon
builds it:

```bash
curl -fsS -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Movies HEVC","templateId":"transcode-hevc",
       "templateValues":{"encoder":"hevc_nvenc","quality":"22"}}' \
  http://localhost:8265/api/v1/flows
```

A template id with a typo in it is refused by name, and nothing is stored:

```
$ docker exec trawlarr-lab trawlarr flow add --name Bad --template transcode-hvec
Error: flow add: no flow template "transcode-hvec". Available: transcode-hevc.
(exit 1)
```

The same is true of a `--set` naming a parameter the template does not have:
it is refused rather than ignored, because an ignored typo would silently give
you the template's *default* — a flow that validates, stores, runs, and does
the wrong thing to a library.

**What the template builds**, so you can check it against your Unmanic stack:
Start → Check Video Codec → (output 2, "differs") → Begin Command → Set Video
Encoder → Execute → Verify Output → Replace Original File. Output 1 of Check
Video Codec — "already this codec" — is connected to nothing, on purpose
(§2.2).

If you prefer to read a flow before you trust it with a library, the same two
flows are checked in as files:

- [`docs/flows/transcode-hevc-cpu.json`](flows/transcode-hevc-cpu.json) — `libx265`
- [`docs/flows/transcode-hevc-nvenc.json`](flows/transcode-hevc-nvenc.json) — `hevc_nvenc`

Both are generated from the same template and validated by the test suite, and
either can be loaded with
`trawlarr flow add --name "Movies HEVC" --file /config/flow.json` after
copying it into your `./config` directory.

### 3.5 Attach the flow to the library

```
$ docker exec trawlarr-lab trawlarr library set-flow --library Movies --flow "Movies HEVC"
Library "Movies" now uses flow "Movies HEVC".
```

Equivalent: `PATCH /api/v1/libraries/<id>` with `{"flowId":"<flow id>"}`.

A library with no flow attached is *paused*, and says so — attaching one is
what starts the work.

### 3.6 Watch it converge

Nothing else is needed from you. The daemon scans, queues and runs on its own;
you do not run `scan` or `run` by hand.

```
$ docker exec trawlarr-lab trawlarr status --library Movies --files
Movies: 3 file(s) — good 0, queued 2, held 0, running 0, failed 0, not_converging 0, unknown 1 (0% converged)
  961e6b9e-6c4c-4ee2-8c6c-ff581e02b694  queued          attempts 0  /library/Already.HEVC.2021.mkv
  f3edf85e-f5fe-4a1e-bcf9-964e15beedc7  queued          attempts 0  /library/Sample.Movie.2020.mkv
  d7d09cbe-4a2b-43b5-94f5-dcbbe3427f99  unknown         attempts 0  /library/Seeding.Show.S01E01.mkv
```

and shortly after:

```
$ docker exec trawlarr-lab trawlarr status --library Movies --files
Movies: 3 file(s) — good 2, queued 0, held 0, running 0, failed 0, not_converging 0, unknown 1 (66% converged)
  961e6b9e-6c4c-4ee2-8c6c-ff581e02b694  good            attempts 0  /library/Already.HEVC.2021.mkv
  f3edf85e-f5fe-4a1e-bcf9-964e15beedc7  good            attempts 0  /library/Sample.Movie.2020.mkv
  d7d09cbe-4a2b-43b5-94f5-dcbbe3427f99  unknown         attempts 0  /library/Seeding.Show.S01E01.mkv
```

Equivalent: `GET /api/v1/libraries/<id>/stats`.

Three things in that output are worth reading rather than skimming.

**One file actually changed codec.** It was `h264` before the run:

```
$ docker exec trawlarr-lab ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "/library/Sample.Movie.2020.mkv"
h264
```

and is `hevc` after it, at the same path:

```
$ docker exec trawlarr-lab ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "/library/Sample.Movie.2020.mkv"
hevc
```

**`Already.HEVC.2021.mkv` went to `good` without being transcoded** — it took
output 1 of Check Video Codec and stopped there. That is the dead end from
§2.2 doing its job.

**The original is in the trash, and staging is empty**, which is what a clean
replacement looks like:

```
$ docker exec trawlarr-lab ls -l /library/.trawlarr/trash /library/.trawlarr/staging
/library/.trawlarr/staging:
total 0

/library/.trawlarr/trash:
total 20
-rw-r--r-- 1 trawlarr trawlarr 19824 Aug 20 06:27 Sample.Movie.2020.1787232508279.mkv
```

**And one file did nothing at all.** `Seeding.Show.S01E01.mkv` is sitting at
`unknown` with `attempts 0`. It is not broken and it is not stuck. Read §5
now — this is the single most likely reason a working install looks broken to
someone coming from an \*arr stack.

---

## 4. Your plugin stack, mapped

Trawlarr's first-party node set is **seven nodes**: Start, Check Video Codec,
Begin Command, Set Video Encoder, Execute, Verify Output, Replace Original
File. That is enough for a transcode library and not enough for everything
Unmanic's plugin ecosystem does.

Below is every common Unmanic behaviour and an honest verdict. The rows that
say **Not yet** are there precisely so you find out here rather than halfway
through moving your library.

| Unmanic step | Trawlarr today | Verdict |
| --- | --- | --- |
| Transcode video to HEVC / H.264 / AV1 | `transcode-hevc` template (`targetCodec` picks which) | **Supported** |
| Skip files already in the target codec | `Check Video Codec`, output 1 left unconnected | **Supported** |
| Choose an NVENC / QSV / VAAPI encoder | `Set Video Encoder` + `TRAWLARR_HARDWARE` | **Supported** |
| Pick a quality (CRF/CQ/QP) | `Set Video Encoder` `quality` — the right flag for the encoder is chosen for you | **Supported** |
| Keep the original file for N days | `Replace Original File` → `<root>/.trawlarr/trash` | **Supported**, with the limits in §6 |
| Verify the output before replacing | `Verify Output` | **Supported** — probes cleanly, duration and stream count within tolerance, size sanity floor |
| Limit how much runs at once | `NUMBER_OF_WORKERS`, `TRAWLARR_HARDWARE_CAPS` | **Supported** |
| Only run during certain hours | Schedule windows (`TZ` + schedule settings) | **Supported** |
| Ignore files below a size / by extension | Library `--extensions` | **Partial.** Extension filtering yes; size/bitrate thresholds have no node. |
| Remux to a different container (mkv ⇄ mp4) | — | **Not yet.** Needs a first-party remux node or a community plugin. |
| Transcode or normalise audio (AAC, EAC3, loudness) | — | **Not yet.** Same. |
| Strip tracks by language, drop commentary, keep subtitles | — | **Not yet.** Same. |
| Rename, move or copy the result to another directory | — | **Not yet.** Same. |
| Notify a webhook / Discord / Telegram on completion | — | **Not yet.** Same. The WebSocket carries live job events, so a small script can do it today, but there is no node. |
| Extract or burn in subtitles | — | **Not yet.** Same. |
| Any specific community Unmanic plugin | — | **Not applicable.** Trawlarr runs *Tdarr flow* plugins, not Unmanic plugins. Unmanic plugins cannot be imported, and no shim is planned. |

If your Unmanic stack is "transcode everything that is not HEVC, keep the
original for a while", every row you need is Supported and §3 is your whole
migration. If it also normalises audio or strips foreign-language tracks,
those steps do not come across yet — you would keep doing them elsewhere, or
wait for the nodes.

---

## 5. Hardlinked files are skipped by default

**If trawlarr appears to do nothing at all with a library fed by a torrent
client, this is why.** It is not a bug, it is not a permissions problem, and
nothing about it is an error.

A file with more than one link is tracked but never queued. It is not probed,
no job is created, and it sits at `unknown` with `attempts 0` for ever — which
is what `Seeding.Show.S01E01.mkv` was doing in §3.6. Every scan says how many
it passed over.

This is the normal shape of an \*arr setup: qBittorrent's download directory
and your library are two names for one inode, which is what makes the import
instant and the seeding copy free. Replacing such a file would either break
that link or mutate the copy you are still seeding, and trawlarr will not
decide that for you.

Your options, in the order most people want them:

1. **Leave it.** Those files converge on their own once seeding stops and the
   download copy is removed: `nlink` drops to 1, the next scan probes and
   queues them. Nothing is needed from you.

2. **Turn it off deliberately, per library.** `--allow-hardlinked` on
   `trawlarr library add`, or on a library that already exists:

   ```
   $ curl -fsS -X PATCH -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
       -d '{"allowHardlinked":true}' http://localhost:8266/api/v1/libraries/$LIB | jq .allowHardlinked
   true

   $ docker exec trawlarr-lab trawlarr scan --library Movies

   $ docker exec trawlarr-lab trawlarr status --library Movies --files
   Movies: 3 file(s) — good 3, queued 0, held 0, running 0, failed 0, not_converging 0, unknown 0 (100% converged)
     961e6b9e-6c4c-4ee2-8c6c-ff581e02b694  good            attempts 0  /library/Already.HEVC.2021.mkv
     f3edf85e-f5fe-4a1e-bcf9-964e15beedc7  good            attempts 0  /library/Sample.Movie.2020.mkv
     d7d09cbe-4a2b-43b5-94f5-dcbbe3427f99  good            attempts 0  /library/Seeding.Show.S01E01.mkv

   $ docker exec trawlarr-lab ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "/library/Seeding.Show.S01E01.mkv"
   hevc
   ```

   No `requeue` is needed — those files were never failed, only never started.

   **Know what that does to the other name**, because it is not what most
   people expect. The replacement is a *new* file at the library path; the
   original is **moved** into `<root>/.trawlarr/trash`. Your torrent client's
   copy is neither modified nor deleted — it now shares its inode with the
   trashed original and goes on seeding the old content until the trash
   retention sweep removes it. Budget the disk for that, and know that the two
   names have parted company.

There is a second guard behind this one, inside Replace Original File, for a
file that acquires a link between the scan and the run. It refuses **before
anything moves**, so the original is never at risk — at the cost of one
attempt against that file.

---

## 6. Before you point it at everything

### The safety story, and exactly where it stops

Every recovery path in trawlarr depends on the trash. There is no undo that
does not go through `<library root>/.trawlarr/trash`.

What protects you:

- The original is **moved**, not deleted, when a file is replaced.
- Nothing is replaced unless the flow contains a `Replace Original File` node
  (§2.5).
- `Verify Output` runs before the replacement: the new file must probe
  cleanly, match the original's duration and stream count within tolerance,
  and clear a size sanity floor. A 40 GB film becoming 200 MB fails
  verification rather than replacing anything.
- The replacement itself is an atomic rename (§2.1), so there is no moment at
  which a truncated file exists at your film's path.
- Hardlinked files are refused rather than guessed about (§5).

**Where it stops, and this is the part to take seriously: nothing purges the
trash on a schedule you did not run.** The retention sweep runs at the end of
`trawlarr run` and on demand with `trawlarr trash purge`. Retention is a
per-flow setting (`trashRetentionDays`, 14 by default; where a flow has
several replace nodes the longest wins), but it is a *rule the sweep applies*,
not a timer. That cuts both ways:

- Your trash **will** grow until a sweep runs. Plan disk for it. Check it:

  ```
  $ docker exec trawlarr-lab trawlarr trash purge --library Movies --days 14 --dry-run
  Trash for "Movies" (retention 14 day(s)): would remove 0 file(s), 0 B; 2 still within retention, 0 left alone (not trawlarr trash entries).
  ```

- And once a sweep does remove an entry, **that original is gone**. There is
  no second copy. Shorten `trashRetentionDays` deliberately, and never to zero
  on a first run:

  ```
  $ docker exec trawlarr-lab trawlarr trash purge --library Movies --days 0 --dry-run
  Trash for "Movies" (retention 0 day(s)): would remove 2 file(s), 30.9 KiB; 0 still within retention, 0 left alone (not trawlarr trash entries).
  ```

  Note `--dry-run` in both. Use it first, every time.

The sweep only ever touches entries inside a resolved trash directory, and it
ages them by when trawlarr trashed them rather than by their file timestamps —
a move preserves mtime, so a 2009 film trashed today is not an old trash
entry.

Trawlarr's trash is **not a backup**. It protects you from trawlarr. It does
not protect you from a failing disk, and it does not protect you from the
sweep you ran yourself.

### Start narrow

1. Point trawlarr at **one small library, or a copy** — not your whole media
   tree. The trial directory from §0B is ideal.
2. Let a handful of files converge. Confirm three things by looking, not by
   assuming: the files play, `ffprobe` reports the codec you asked for, and
   `<root>/.trawlarr/trash` contains their originals.
3. Only then widen the roots, or add the rest of your libraries.

The reason to do it in that order is that step 2 is where a wrong `PUID`, a
wrong hardware declaration, or a flow missing its replace node shows up — on
three files instead of thirty thousand.

### Then

`docs/deployment.md` is the reference for everything operational: volumes,
every environment variable and whether it seeds or overrides, permissions,
exposure, upgrades, and a troubleshooting table. This guide only covered the
parts that differ from what you already know.
