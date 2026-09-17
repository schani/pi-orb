# Native macOS prototype

**Status:** prototype, decided 2026-09-17. It lives in `apps/macos` alongside the web UI and is not a second product surface. It is local-only and unauthenticated.

## Purpose

Find out what a non-browser client needs from the pi-orb backend. The web UI and the control plane grew together, so browser assumptions are invisible from inside the browser. A small native client written against the published contracts alone — `packages/protocol/src/frames.ts`, `history.ts`, `control-plane-api.ts` — makes them visible. The findings below are the deliverable; the app is the instrument.

## Scope

Built:

- sidebar of projects and their orbs from `GET /api/v1/projects` and `GET /api/v1/projects/:id/orbs`, polled every two seconds;
- transcript from `GET /api/v1/orbs/:id/history` plus the live WebSocket at `/api/v1/orbs/:id/live`;
- rendering of user text and shell output literally, assistant text as parsed Markdown, tool calls coalesced into one row per category, `pi.bash_execution` shell command/output, and `custom.display` event text;
- live output blocks and tool chips while an operation runs, with a busy indicator driven by `status`/`operation_started`/`operation_finished`;
- composer writing to the durable inbox with `PUT /api/v1/orbs/:id/messages/:uuid`, showing the message inline until a record claims it through `inboxMessageIds`;
- Start and Stop.

Excluded: authentication, terminal, uploads, settings, project configuration, notifications, on-disk transcript cache, menu bar item, image input, shell composer modes, abort, subagent rosters, and turn notifications. Assistant reasoning is decoded and dropped. `overflow` is never read; the client decodes only the normalized fields it renders (`shell`, `custom`, `inboxMessageIds`, `failure`, tool-call `arguments`, and the `tool_result` `patch`), and ignores `subagent`.

**Markdown.** `parseMarkdown(_:) -> [MarkdownBlock]` turns assistant text into paragraphs with inline runs (text, code, emphasis, strong, link), headings, fenced code with its language, ordered and unordered lists, block quotes, thematic breaks and GFM tables. Apple's [swift-markdown](https://github.com/swiftlang/swift-markdown) is the package's only dependency; anything it produces that the tree cannot hold degrades to a paragraph or a code block rather than vanishing. User messages, shell output and tool results are literal and are never parsed.

**Tool activity.** `toolGroups(runId:calls:) -> [ToolGroup]` ports `apps/web/src/components/ToolActivity.tsx`: adjacent calls inside an agent turn form one maximal run, which `present(_:pending:)` cuts at rendered prose, a shell block, a note, a failure or a user turn; each run splits into `edit` / `command` / `read` / other categories by tool name, and a category of one names its file or command while larger runs carry a count of unique paths, `N ran`, or `+A −R` from the result `patch`. Live `tool_state` chips join the same structure and are dropped when the call is already committed to history. Reasoning does not cut a run: this client drops it, so a cut there would show two rows with nothing between them to explain the break.

## Stack

SwiftPM only — `swift build`, `swift test`, `swift run PiOrb` — with no Xcode project, on macOS 26 with the Swift 6.4 toolchain. `Sources/PiOrbModel` is a SwiftUI-free library: `Codable` protocol types, the `URLSession` API client, the `URLSessionWebSocketTask` live connection, a pure `TranscriptReducer`, a pure Markdown parser, a pure tool-run grouper, and a pure `present(state:pending:)`. `Sources/PiOrb` is the SwiftUI executable. `Tests/PiOrbModelTests` covers decoding, reduction, and presentation with no network.

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

## Look (Inverted bands decided 2026-09-17)

The first look was bland, so five transcript designs were built and compared
side by side against the live control plane. **Inverted bands** was selected:
the web UI's own look — full-width monochrome bands, inverted user turns, the
bit-register busy marker, a text field that inverts on focus. Rejected by user
preference after that comparison: Paper (warm stock, serif prose, ledger tool
lines), Terminal (near-black ground, phosphor accent, `❯` prompt), Native
(`.regularMaterial`, system fonts, accent bubbles, SF Symbols), Ledger (dense
dark rows behind a timestamp gutter). The switcher that carried them is gone.

The choice applies to the whole window, not only the transcript, and mirrors
`docs/web-ui.md` rather than inventing: one 13px monospace face on a 20px row,
white ground, black ink, the three greys and two signal hues of
`apps/web/src/styles.css`, 1px black rules, `#f2f2f2` hairlines, zero radius,
and inversion instead of tint for focus and the current row. Light only, as on
the web — `styles.css` declares `color-scheme: light` and has no
`prefers-color-scheme` mapping, so the window forces the light appearance.

- **Sidebar** is the web's orb index at 236px behind a black right rule: each
  project name an uppercase, letter-spaced label over a black rule, each orb one
  20px row of the 16px instrument tile (the exact geometry of
  `apps/web/public/favicons/*.svg`, redrawn as paths) and the name truncated to
  one line, behind a 2px border in the state's hue, with a `#f2f2f2` hairline
  below. The selected row is inverted and bold, as `.ix-row-current` is. The top
  band holds the traffic lights where the web puts its `PI-ORB` row.
- **Header** is the web's orb header: the name in bold, then Start and Stop as
  boxed text buttons where the web's lifecycle cluster sits, inverting on hover
  and press and dimmed to `--g2` when the state refuses them.
- **Window chrome** is a full-size content view with a transparent title bar and
  no title text, so the bands run edge to edge; the toolbar and its sidebar
  toggle are removed and `SidebarCommands` keeps ⌃⌘S. The top band is the
  macOS title bar's 28px rather than the web's 24px, so the traffic lights fit.
- **Composer** is the web's: a 32px `>` prefix column, a borderless four-line
  field that inverts on focus, and the send mark from `Icons.tsx` as an
  icon-only action. ⌘⏎ and ⏎ both send.
