# Alerts — Design Spec

**Date:** 2026-10-17
**Status:** Draft, awaiting approval
**Resolves:** GitHub issue #60 (push a notification when something fails)
**Extends:** the daemon event bus (`packages/server/src/daemon/events.ts`), global settings
(`packages/server/src/db/settings-repo.ts`), and the first-party flow nodes in
`@trawlarr/plugins-core`.

---

## 1. Purpose

A failure today is only visible if someone opens the UI, and one can sit unnoticed for days.
Trawlarr should push a message to an external system when something needs a person, so
visibility does not depend on watching a screen. Home Assistant is the first receiver.

The feature is called **Alerts** in the code and UI, not "notifications". "Notification"
already means the _inbound_ Sonarr/Radarr/Lidarr hooks here (`POST /notify/arr`, the
NotificationPaths screen), and reusing the word would make both harder to talk about.

### 1.1 Goals

1. Trawlarr sends a small JSON `POST` to one or more user-defined webhook **destinations**
   when an alert event happens.
2. Two sources feed the same delivery path:
   - **Daemon alerts**, raised automatically for events no flow can see (§3).
   - A **Send Webhook** flow node, for events inside a flow run (§4).
3. A single cause that hits thousands of files produces a handful of messages, not thousands
   (§5).
4. A dead or slow receiver can never block, slow, or fail a job, a scan or a shutdown.

### 1.2 Non-goals

- **Not Apprise**, and no per-service integrations (ntfy, Gotify, Slack, Discord). One
  generic JSON webhook; anything that accepts a webhook works, and Home Assistant does
  directly. Decided: the Apprise CLI would add Python to the runtime image, and a native
  webhook gives one delivery mechanism for both sources.
- **No per-library destinations or routing.** One global list. Revisit if a second library
  ever needs different routing.
- **No durable delivery.** The send queue is in memory and is lost on restart (§6).
- **Not an inbound channel.** Alerts never change library or file state, and nothing
  durable may depend on one being sent or received.
- Not a replacement for the UI. An alert says _that_ something happened and links to where
  to look.

### 1.3 Anti-goals

- An alert flood that buries the one message that matters, which is worse than no alerts.
  This is what §5 exists to prevent.
- A secret leaking through the API, logs, the flow definition, or an exported flow.
- Delivery trouble becoming job trouble.

---

## 2. Destinations

A destination is configured once, in a global **Alerts** section of settings. There is one
list for the whole installation.

| Field   | Notes                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| name    | Unique, how a flow node refers to it.                                                                         |
| url     | `http://` or `https://`. **A secret**: a Home Assistant webhook URL is itself a credential.                   |
| headers | Optional name/value pairs, for receivers that need an `Authorization` header. Values are **secrets**.         |
| events  | One on/off toggle per daemon event type (§3). Does not affect Send Webhook nodes, which send when they run.   |
| enabled | Lets a destination be switched off without deleting it.                                                       |

**Secrets** are stored and returned the way the API key is: the API returns them masked and
never in full once saved; an edit that leaves the field untouched keeps the stored value;
the UI shows them masked. They are never written to logs, and a delivery-failure log line
names the destination, not its URL.

**Test notification.** Each destination has a "send test" action that sends a clearly
labelled test event (`event: "test"`) through the real delivery path and reports the
result: status code or error, in the UI.

**Public base URL.** A separate global setting, the address at which the user reaches
trawlarr (for example `https://trawlarr.example`). It is used only to build the `url` link
in payloads (§7). When it is empty, payloads omit `url`; nothing else changes.

---

## 3. Daemon alerts

Raised by the daemon from facts it already holds, with no flow involved. A destination
receives only the event types toggled on for it. **Default for a new destination: all on.**

| Event type            | Raised when                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `file.failed`         | A file reaches `failed` (retry budget spent).                                                |
| `file.not_converging` | A file reaches `not_converging` (the flow keeps changing it without settling).               |
| `node.offline`        | A node stays offline past the offline grace window, or is refused (revoked, protocol mismatch). |
| `library.root_missing`| A library root cannot be shown to be present (the unmounted-NAS case).                        |
| `scan.aborted`        | A scan aborts.                                                                               |
| `library.paused`      | A library is paused because its flow is invalid.                                             |
| `hardware.check_failed`| A hardware declaration fails its startup check (for example NVENC declared but absent).     |

Not alerted, by decision: a single failed _attempt_ that will be retried. That is noise.

**Recovered events.** The outage-style events (`node.offline`, `library.root_missing`,
`scan.aborted`, `library.paused`, `hardware.check_failed`) send a matching
`<event>.recovered` when the condition clears, so "NAS missing" is not left standing with no
word that it came back. Recovered is sent to a destination iff the destination has the
original event on. This was a design call, not a stated requirement.

`file.failed` and `file.not_converging` are terminal states that need a human; they have no
recovered event (a requeue is a person acting, not a condition clearing).

Manual-review holds are **not** a daemon alert: Hold for Review is itself a flow node, so
a flow that wants a message on a hold puts a Send Webhook node on that branch (§4).

### 3.1 Where they come from

Most of these already surface on the daemon event bus (`job.finished` with a terminal
`state`, `nodes.changed`, `library.paused`, `scan.finished` with `rootsUnavailable`).
The builder decides, per event, whether an existing bus event is enough or a new one is
needed. Two constraints:

- Alerts subscribe to the bus. They must not add work to the paths that emit.
  `emit` already swallows a listener's exception for exactly this reason; an alert listener
  must never throw into a job's completion.
- A terminal state must alert however it was reached, including a job whose worker was
  killed or whose lease expired, not only a flow that ran to an On Error node. Confirm every
  route into `failed` and `not_converging` is covered.

---

## 4. The Send Webhook flow node

A first-party node in `@trawlarr/plugins-core`, alongside Write to Log and Fail File.

**Inputs:** the destination (chosen by name from the global list) and a message. The message
is a short template with the usual flow-variable substitution (file name, library, etc.).

**Behaviour:**

- Sends one event, `event: "flow.message"`, through the same delivery path as daemon
  alerts, subject to the same non-blocking and bounded delivery (§6).
- **Never fails the flow.** If the destination is unknown, disabled, or unreachable, the
  node logs that to the job log and continues on its single output. A notification problem
  is not a reason to mark a file failed.
- Contains no URL or secret. It names a destination.

**Interaction with the convergence signature.** The signature is the whole flow
definition's hash. A node's inputs are part of that definition, so **editing a Send Webhook
node's message or destination name changes the flow's signature and re-queues every file
the flow governs**, exactly as any other node edit does. This is accepted, not avoided.
The reason it is a node that references a destination _by name_, rather than carrying the
URL, is the same reason the Plex token is per-library and not in the flow: rotating a
secret, or changing where alerts go, then touches only the destination and re-queues
nothing. The design deliberately keeps everything that should change freely (URL, headers,
event toggles) out of the flow.

**Community plugins.** The Tdarr corpus has an Apprise plugin. It is not supported here
by decision (§1.2) and is not shipped in the image.

---

## 5. Noise control

Events are coalesced by a **key**: the event type, the library (or node), and the cause.
The cause is a normalised reason, not the raw message, so thousands of files failing on the
same missing mount share a key.

- The **first** event for a key is sent immediately.
- Further events with the same key inside a **window (default 15 minutes)** are counted, not
  sent. When the window closes with a count, one follow-up is sent: how many more, and a
  few example paths.
- Outage events that are already one per library or node (`library.root_missing`,
  `node.offline`) do not need per-file counting, but a condition that **stays** down sends a
  "still down" repeat **at most hourly**, so a long outage is not silent after the first
  message.
- `flow.message` events are not coalesced: they are deliberate and the flow author controls
  their frequency. They are still subject to the delivery limits in §6.

Coalescing state is in memory. Window and repeat intervals are constants first and
configurable later if they prove wrong.

Reuse the existing precedent: `packages/server/src/library/plex-notify.ts` already
coalesces outbound calls in a window and stops on shutdown ("sending after shutdown is
worse than not sending"). Follow its shape.

---

## 6. Delivery

- Sending is **off the job path**: queued and sent asynchronously. No job, scan, claim or
  shutdown waits on an alert.
- Each attempt has a **10-second timeout**; up to **3 retries** with backoff.
- The queue is **in memory**. On restart, unsent alerts are dropped, and the daemon logs
  how many. This is deliberate: an alert is a notification, never the record (see
  `events.ts`), and the state that caused it is in the database and visible in the UI.
- Drain on shutdown is **bounded**: the daemon must not hold a stop open for a dead
  receiver. Unsent alerts at deadline are dropped and counted.
- A bound on the queue (builder's choice of size) so a long receiver outage cannot grow
  memory without limit; overflow drops the oldest and counts it.
- Failures are visible: a log line per failed delivery (destination name, status or error,
  never the URL) and the last result per destination on the settings page.
- Only `http:` and `https:` URLs are accepted. Redirects are not followed to another origin
  with credentials attached (the builder confirms how the HTTP client handles this).

---

## 7. Payload

A JSON `POST` with `Content-Type: application/json`, plus any destination headers.

```json
{
  "event": "file.failed",
  "at": "2026-10-17T18:04:11Z",
  "summary": "Movie (2019).mkv failed after 3 attempts",
  "library": "Movies",
  "path": "/library/movies/Movie (2019)/Movie (2019).mkv",
  "reason": "Replacement refused: ...",
  "url": "https://trawlarr.example/jobs/<id>",
  "count": 1
}
```

- `event` is one of the types in §3, a `.recovered` variant, `flow.message`, or `test`.
- `summary` is a single human-readable line, suitable as a push notification body.
- `library`, `path`, `reason`, `url` are present when they apply and omitted otherwise.
- `url` is built from the public base URL and is omitted when that is unset.
- `count` and an `examples` list appear on a coalesced follow-up (§5).
- Field names are a wire contract once released: additive changes only.

Paths and reasons are the user's own library data going to a destination the user chose;
no secret (API key, destination URL or header) may appear in any payload.

---

## 8. Constraints and invariants

- **`@trawlarr/core` stays pure.** No I/O, no clock. Anything time-based, such as the
  coalescing window, takes `nowMs` as a parameter, or lives in `server`. Pure pieces (key
  derivation, window logic, payload shaping) belong in `core` only if they need no I/O.
- **Dependencies flow one way** (`plugin-api` → `core` → `plugins-core` → `engine` →
  `server`). The Send Webhook node sits in `plugins-core` and reaches the daemon's
  delivery through the injected plugin `deps`, not by importing `server`. The builder
  chooses the mechanism; it must work for a job run by a **remote node**, whose process is
  not the daemon (see the remote-nodes design) — the node's request must reach the
  daemon's delivery path, since destinations and secrets live on the server only.
- **Secrets never reach a node.** A remote node must not be sent destination URLs or
  headers. It asks the daemon to send.
- **A migration** adds storage for destinations and settings; migrations are forward-only
  and numbered.
- **The daemon↔agent protocol is a wire format** (plain JSON only); any message added for
  the Send Webhook node follows that rule.
- Match the codebase: comments explain _why_, citing the defect that motivates a rule.

---

## 9. Testing

- Coalescing, windows and the "still down" repeat, against an injected clock.
- A receiver that is down, slow (past the timeout) and flapping: jobs, scans and shutdown
  are unaffected, and the failure is logged and shown.
- A flood (thousands of `file.failed` events with one cause) produces the first message and
  one summary, not thousands.
- Secrets never appear in API responses, logs or payloads.
- Send Webhook with an unknown, disabled and unreachable destination: the flow continues
  and the file's outcome is unchanged.
- Send Webhook from a job on a remote node reaches the destination via the daemon.
- A terminal state reached by a killed worker or expired lease still alerts.
- Web component tests for the settings section, including masked-secret edit behaviour.
- A real local HTTP receiver in tests, not a mocked client, for the delivery path.

---

## 10. Left to the builder

- Storage shape for destinations, and how event toggles are stored.
- The exact set of new bus events versus reusing existing ones (§3.1).
- Queue size, backoff schedule, the cause-normalisation rule, and the summary wording.
- The mechanism by which a flow node, including one on a remote node, asks the daemon to
  send (§8).
- The settings UI layout, within the terse-copy convention: short labels, no help
  paragraphs explaining implementation.
- Whether the window and repeat intervals are constants or settings in the first release.

---

## 11. Calls made in review

Settled by the author after a fresh read of this document. None was stated by the user, so
each is open to being overturned.

1. **`scan.aborted` vs `library.root_missing`.** A scan that stops because a root cannot be
   shown to be present (`rootsUnavailable`) raises only `library.root_missing`. `scan.aborted`
   is for a scan that stopped on a thrown failure. One NAS outage must never send both.
2. **`library.paused`** alerts only on _automatic_ pauses (an invalid flow, and any other
   daemon-initiated reason). An operator's own pause (`operator: …`) does not alert. It
   clears on `library.resumed`, from any source, including an operator resume.
   `scan.aborted` clears on the library's next successful scan.
3. **Cause key.** The cause is the failure reason with paths, numbers and attempt counts
   stripped. At most **10 distinct causes per library per window** are sent individually;
   the rest are folded into an "N other causes" line on the follow-up, so a second,
   unrelated failure is never hidden for a whole window.
4. **Restart.** Coalescing and outage state are not persisted. A condition still standing at
   boot alerts once, after a short startup delay (builder's choice, on the order of two
   minutes) so a crash-looping container does not alert on every start. A condition that
   cleared during downtime sends no `.recovered`; that is accepted.
5. **Destination names.** Deleting or renaming a destination that a published flow refers to
   is refused, naming the flows. At run time an unknown or disabled destination logs to the
   job log and the flow continues. Flow validation **warns**; an unknown destination never
   makes a flow invalid, so it can never pause a library.
6. **Remote nodes.** A node's Send Webhook request is fire-and-forget over the existing
   channel: if the node cannot reach the daemon the alert is lost, and that is accepted. The
   daemon fills `library`, `path` and `url` from the job's own context; the node supplies
   only the destination and the message.
7. **Redaction.** `reason`, example paths and `summary` are scrubbed of every _known stored
   secret_ (destination URLs and header values, the API key, Plex tokens, other stored
   tokens) before sending. No pattern-based guessing.
8. **Per-destination state.** Coalescing and the "still down" clock are global per key, not
   per destination; destinations filter at send time. A destination whose toggle is turned
   on mid-outage receives nothing until the next hourly repeat.
