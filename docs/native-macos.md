# Native macOS prototype

**Status:** prototype, decided 2026-09-17. It lives in `apps/macos` alongside the web UI and is not a second product surface. It is local-only and unauthenticated.

## Purpose

Find out what a non-browser client needs from the pi-orb backend. The web UI and the control plane grew together, so browser assumptions are invisible from inside the browser. A small native client written against the published contracts alone — `packages/protocol/src/frames.ts`, `history.ts`, `control-plane-api.ts` — makes them visible. The findings below are the deliverable; the app is the instrument.

## Scope

Built:

- sidebar of projects and their orbs from `GET /api/v1/projects` and `GET /api/v1/projects/:id/orbs`, polled every two seconds;
- transcript from `GET /api/v1/orbs/:id/history` plus the live WebSocket at `/api/v1/orbs/:id/live`;
- rendering of user text, assistant text as plain text, one line per `tool_call` with a mark from its later `tool_result`, `pi.bash_execution` shell command/output, and `custom.display` event text;
- live output blocks and tool chips while an operation runs, with a busy indicator driven by `status`/`operation_started`/`operation_finished`;
- composer writing to the durable inbox with `PUT /api/v1/orbs/:id/messages/:uuid`, showing the message inline until a record claims it through `inboxMessageIds`;
- Start and Stop.

Excluded: authentication, terminal, uploads, settings, project configuration, Markdown, notifications, on-disk transcript cache, menu bar item, image input, shell composer modes, abort, subagent rosters, and turn notifications. Assistant reasoning is decoded and dropped. `overflow` is never read; the client decodes only the normalized fields it renders (`shell`, `custom`, `inboxMessageIds`, `failure`), and ignores `subagent` and the `tool_result` `patch` diff because nothing renders them.

## Stack

SwiftPM only — `swift build`, `swift test`, `swift run PiOrb` — with no Xcode project, on macOS 26 with the Swift 6.4 toolchain. `Sources/PiOrbModel` is a SwiftUI-free library: `Codable` protocol types, the `URLSession` API client, the `URLSessionWebSocketTask` live connection, a pure `TranscriptReducer`, and a pure `present(state:pending:)`. `Sources/PiOrb` is the SwiftUI executable. `Tests/PiOrbModelTests` covers decoding, reduction, and presentation with no network.

A SwiftPM executable has no application bundle, so it launches as an accessory process; `AppDelegate` sets `.regular` activation and activates on launch.

```sh
cd apps/macos
swift test
swift run PiOrb
```

`PI_ORB_BASE_URL` selects the control plane, defaulting to `http://127.0.0.1:7100` — the Docker-free service in `README.md`.

## Protocol rules the client depends on

- **Unknown frames and events are ignored, never fatal** (`docs/runtime-protocol.md`). Each unrecognized `type` decodes to an `.unknown` case. This is what makes a second client cheap: the prototype understands seven server frames and five runtime events and drops `subagents`, `turn_notification`, `agent_settings`, and anything added later without a schema library or a version negotiation.
- **Synchronization modes.** `client.hello` carries the last applied record id; `sync.started` with `mode: "full"` clears records, `mode: "after"` keeps them, and both clear transient live state. `history.record` upserts by id in insertion order and retires the live blocks it supersedes.
- **The durable inbox is the send path.** `PUT /api/v1/orbs/:id/messages/:uuid` is accepted for stopped and running orbs alike, so the composer needs no live socket and no `expectedHeadId`. The prototype never sends `client.request`.
- **The live socket is only for running orbs.** The control plane closes with 1013 otherwise, so the client connects on entering `running` and disconnects on leaving it, with a two-second reconnect backoff in between.

## Local only

There is no authentication. In the `dev:local` composition the control plane mints a fixed `pi-orb:local`/`developer` identity for every request, so the prototype sends no credentials at all. A deployed native client needs both real authentication — the browser path is an IAP JWT assertion, which a native app does not have — and the trusted-company identity model of `docs/multi-user.md` (open question 24, resolved 2026-09-16). Neither is in scope here.

## Findings

- **Presence is browser-shaped and load-bearing.** `client.presence` reports `document.visibilityState`, and the control plane treats a connection that has never reported visibility as hidden (`docs/lifecycle.md`), so a client that skips the frame gets its orbs idle-stopped while the user watches. The prototype sends `visible: true` once per connection. A native window has occlusion, miniaturization, and Space membership rather than tab visibility, and the boolean has no vocabulary for "connected but unattended"; the prototype's single report is therefore the leaky direction — a forgotten window keeps an orb alive.
- **The sidebar costs one request per project per poll.** There is no combined fleet listing and no change feed for lifecycle state, so every client re-derives the same view by polling `1 + N` endpoints. The browser hides this behind a single page; a native client makes it obvious.
- **Queued messages live in two places.** The transcript carries `inboxMessageIds` only on the delivered record, so "queued" before delivery is knowable only from `GET /api/v1/orbs/:id/messages`. A client that keeps pending state in memory — as this one does — shows nothing after a relaunch even though the message is still durably queued.
- **Orb creation returns HTTP 500 for an id the schema accepts.** `CreateOrbRequestSchema` allows any DNS-safe label, but `orbs.id` is a `uuid` column, so `{"id":"macos-proto-1"}` answers `500 internal` carrying the raw PostgreSQL text instead of a typed `400`. This is the first wall a new client hits when scripting orb creation (`TODO.md`).
- **`dev:local` cannot open a pre-023 database and does not say why.** Boot prints only `migration failed code=invariant`; migration 023 requires `PI_ORB_ORIGINAL_USER_ID`, `PI_ORB_ORIGINAL_IDENTITY_ISSUER`, and `PI_ORB_ORIGINAL_IDENTITY_SUBJECT` for a database that already holds projects (`TODO.md`).
- **What the backend got right for a foreign client:** every rendered fact is a normalized typed field, so the prototype never parses harness-native JSON and never touches `overflow`; and history over HTTP plus a live socket that replays from a cursor means a cold client is correct after one GET, with the socket a pure optimization.

## Verified live

Against `dev:local` on 2026-09-17: the sidebar listed the project and orb and tracked `stopped → starting` within the poll interval; Start, Stop, `GET /history`, and inbox enqueue on a stopped orb all succeeded from the client's own code path. The live WebSocket was not exercised end to end — no orb could reach `running` on that machine because its Codex OAuth refresh token is invalid — so the frame handling is covered by unit tests only.
