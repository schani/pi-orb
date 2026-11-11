# Web UI

The browser app in `apps/web` serves one person who already knows the product. Its look, tokens and component specs: `docs/design-system.md`. Feature-specific UI lives with its feature: terminal `docs/terminal.md`, uploads and drag-and-drop `docs/workspace-uploads.md`, alerts `docs/orb-alerts.md`, sleep `docs/lifecycle.md`, deletion/archival `docs/teardown.md`, secrets `docs/credentials.md`, MCP settings `docs/mcp.md`, Claude sign-in `docs/claude.md`, usage `docs/model-usage.md`, previews and hosted files `docs/http-exposure.md`.

## App shell, routing and navigation

| Path | View |
| --- | --- |
| `/` | Dashboard |
| `/projects/:projectId` | Dashboard focused on that project |
| `/projects/:projectId/mcp` | Dashboard with that project's Config open on MCPs |
| `/projects/:projectId/orbs/new?harness=pi\|claude` | Automatic creation (Pi without query) |
| `/orbs/:orbId` | Orb |
| `/orbs` | Orb workspace with no selection |
| `/usage` | Token usage (`docs/model-usage.md`) |
| other | "Page doesn't exist" at the requested URL |

The server serves the built shell for GET/HEAD application paths, including unknown ones (the client renders not-found). Static assets stay authoritative, including the reserved `/assets` and `/favicons` namespaces. API, runtime, hosted-file, `/auth`, OAuth callback/failure and discovery paths never receive the shell; missing assets and APIs never get shell HTML.

Every in-app link is a real anchor, so copy-link, new tab, modified/middle clicks and downloads stay native. A small adapter intercepts ordinary same-tab app links, pushes history without a reload, handles Back/Forward and replaces the creation route after success. If history mutation fails it falls back to `location.assign` or `location.replace` to match, so Back cannot recreate an orb. No hash-route compatibility.

**Tab identity.** A loaded orb route titles the page `{project} · {orb}` (`untitled orb` when unnamed). Loading, missing and non-orb routes use `pi-orb`. `index.html` installs the neutral favicon before React loads; the orb page replaces that one link with its state: stopped (sleeping if `sleepUntil`), running, or busy when running with an open live connection reporting busy. Disconnected tabs fall back to running. Transitional and failed states keep their own marks even with a sleep deadline. Leaving the route restores neutral.

**Share.** Share follows Rename in the orb identity cell and works in every state. From the user gesture it calls `navigator.share` with `location.href` and `document.title`, else copies the URL. Cancel is silent; copy shows `Link copied.` (`role="status"`); failures show an alert and `console.debug` the typed reason, never the URL. Share on other pages is question 84 in `docs/open-questions.md`.

**Copy.** `copyToClipboard` falls back to a temporary selected textarea when the async Clipboard API is absent or denied (plain-HTTP origins). Failure never reports success.

**Turn notifications.** Opening an orb page with permission `default` requests Notification permission once. Each live `turn_notification` shows an OS notification unless the page is visible **and** focused, titled with the orb's current name (after one refresh, so auto-naming lands) or `Orb <id>`. Orb/operation is the tag and dedup key; clicking navigates. Decisions go to the console only. No service worker, push or replay.

**Browser diagnostics.** `window.piOrbDebug.dump()` (also in production; `copy(piOrbDebug.dump())`) returns a detached JSON trace of the latest 200 content-free edges (`inbox`, `navigation`, `cache`, `connection`, `frame_*`, `sync_state`, `scroll_pin`, `viewport`, `masonry`; welcome/sync/history frames, parse/schema rejections by classification and UTF-16 length, applied cursor changes) plus an on-demand summary of the owned transcript, parent-order anomalies and unmatched inbox rows. Only IDs, counts, states, timestamps and classifications; never content, tokens or authenticated URLs; patches and tool deltas are not traced and drop counts state incompleteness. It lives only in tab memory, uploads nothing and never affects reconciliation; a missing entry does not prove a frame was never sent. Steady state records nothing. Capture it before reloading.

## Missing resources

A URL for a resource that does not exist stays at that URL and renders a resource-specific message ("Orb doesn't exist", "Project doesn't exist", "Page doesn't exist") with a `Back to dashboard` link. Silent redirects are rejected: they hide whether the resource was deleted, the URL is stale, or navigation failed. This applies to every resource type and unknown route.

- Only a definitive 404 renders missing; loading and transient read failures show their own errors.
- An orb metadata or history 404 is final for the mounted route. Earlier poll responses cannot clear it or reopen a socket; recovery needs a new navigation (`docs/postmortems/2026-09-18-webkit-missing-resource-race.md`).
- The missing orb view keeps `.orb-main`, so on desktop it sits in column two beside the fixed index instead of underneath it (`docs/postmortems/2026-10-04-ipad-sidebar-overdraw.md`). The index stays usable and Command-K still works.
- Read failures never redirect.

## Dashboard

**Layout.** The board fills the viewport between the totals strip and the footer.
- The **totals strip** shows `N projects`, `N orbs`, `N busy`, `N failed`. It counts loaded data only (`dashboardTotals`); orbs, busy and failed count working orbs. A project whose orb list is in flight contributes nothing. At the right, Usage (`/usage`) and Settings links.
- The **footer** holds Sign out (when available) and `<host provider> host · <database> · v<version>` from `GET /api/v1/system` (refreshed every 10s), plus a deployment-status link when the system reports `awaiting-activation`, `superseded` or unavailable activation. Before the first answer the footer is an empty line.
- Between them, project boxes in **masonry** columns: `max(1, floor(width / column))` equal whole-pixel columns (column width: `docs/design-system.md`), so one full-width column below two column widths. Boxes keep `orderProjects` order and each goes to the shortest column, leftmost on ties. **New project** is always the last box (name, repository URL, `Create project`; errors inline). Accepted cost: a height change can move later boxes to another column. Rejected: a fixed grid whose rows took the tallest project's height and pushed later projects below the fold.
- `useMasonry` (`apps/web/src/lib/use-masonry.ts`, pure placement in `masonry.ts`) positions boxes absolutely without moving them in the DOM, so reflow never remounts a box or the New project form. It re-lays out on board width (a zero-height probe), box resize and in the commit of every board render, so a new box is never observed unplaced. Column/item-count edges log a `masonry` debug entry.

**Project box.** A `ProjectHeader` (shared with the orb index): name, Pi and Claude creation icons, gear (Config) and delete. Then working orbs, then an optional archive. A deleting project keeps its position, disables every action and shows its durable progress line instead of orbs (`docs/teardown.md`). A failed orb-list read shows a scoped error line and hides that project's rows.

**Orb entry.** Line one: state tile and name. Line two: age, with archive and delete when the state accepts them. A failed orb adds its `lastError` line; a deleting orb adds its cleanup blocker. Working rows offer archive and delete, archiving/archived rows delete only, deleting rows nothing. No orb hash.

**Archive.** `archiving`, `archived` and `deleting` orbs sit in a `<details>` footer (`▸ archive · n`). No footer when empty. Native disclosure state survives polls.

**Age.** Time since last update as one number and unit: `12s`, `41m`, `3h`, `2d`, `3w`, `1mo`, `1y` (under a second reads `1s`). No `ago`. Refreshes every 10s (`formatProjectOrbAge`).

**Polling and snapshot.** Projects and orb lists refresh every 2s while mounted. A project renders only once its orb list has loaded or failed, so arriving lists never shift a header between pointerdown and pointerup (`docs/postmortems/2026-10-11-webkit-index-click-layout-shift.md`). The principal-scoped app keeps the last committed dashboard state in memory; returning paints it immediately while the refresh runs. Logout, principal change and reload discard it.

**Ordering.** Ordering never moves a row the user already knows.
- Orbs within each shelf sort by `updatedAt` at first appearance, descending; ties by first-seen `createdAt`, then input position. Keys are UI-local and fixed for the mounted view through failed reads, disappearance, reappearance and shelf transitions. Reload or unmount resets them; invalid timestamps sort last.
- Projects (`orderProjects`) keep their first-observed newest working-orb update, deletion rank and input position. Initially: most recently active first, then projects with no working updates, then deleting projects. Keys survive polls, deletion start and reappearance within the mount.
- Rejected: continuous activity sorting and moving newly deleting projects last.

**Spawned-orb nesting.** On the dashboard and in the index, working orbs nest under their direct working parent in the same project, recursively (`project-orb-tree.ts`). The relation is `OrbView.spawnedByOrb` from immutable `orb_spawns`. Working parents in any working state (including stopped or failed) keep their children; when a parent is archived or disappears, its working children become roots in stable order, with no reparenting writes. The archive is flat and membership independent of family. No collapse, counts or depth settings. Rejected: family blocks, collapsible trees, ghost parents, nearest-ancestor reattachment.

**Addressed projects.** Default lists contain only the signed-in user's projects. A direct project, MCP or orb URL for another user's project fetches only that project and its orbs and shows them while the URL owns them. Reads are fenced by project ID, navigation and successful mutations.

**Focused project.** `/projects/:projectId` renders the normal dashboard, scrolls to the project once loaded, briefly marks it and focuses its heading.

### Orb creation

Each project's Pi and Claude icons are real links to `/projects/:projectId/orbs/new?harness=pi|claude`. The harness is immutable; spawned orbs inherit it.
- **Plain click or keyboard** prevents the default navigation and calls the idempotent create API in place, on the dashboard or in the orb index. The conversation, draft, socket, index and scroll position stay mounted. Both icons disable while that project's request is pending; `creating orb…` and typed failures sit beside the header. Retry reuses the same UUID/harness/time-zone snapshot; choosing the other harness starts a new identity. On acceptance the orb is inserted into its list, older fleet polls are invalidated, and the app navigates to `/orbs/:id` unless the user already navigated elsewhere. Back returns to the previous orb and its draft.
- **Modified click, middle click, context-menu open or direct URL** go to `CreateOrbPage`, which generates its own UUID, submits after reading the project, shows progress or a retryable error, and replaces itself with `/orbs/:orbId`. Generating the ID at the destination means repeated Cmd-clicks create distinct orbs without a side-effecting GET.
- Both paths send the browser's IANA zone as `userTimeZone` when available, fixed across retries.
- Rejected: a separate harness picker page, popover or split button; the whole-screen intermediate page for in-workspace creation.

### Find (Command-K)

Command-K on the dashboard or in the orb workspace opens Find; Control-K stays native, including in the composer. Find is navigation, not a command palette. It searches project names, repository URLs, and working and archived orb names. It never searches IDs, state, transcripts or files, and makes no request per keystroke. Without a registered source (missing-resource and create pages) the browser default applies.

**Architecture.** Three layers with one-way dependencies:
1. `AppSearchProvider` (mounted once) owns the single `keydown` listener, open/query/active-key state, focus restoration and `AppSearchDialog`. It intercepts `metaKey && !ctrlKey && !altKey && key === "k"` only while a source is registered.
2. `apps/web/src/lib/app-search.ts` is the pure core: normalization, matching, stable grouping and the 50-row limit. No React or resource imports.
3. Routes register one source with `useAppSearchSource(source | null)`. `dashboard-search-source.ts` maps loaded `ProjectView`/`OrbView` state; `OrbIndex` reuses it with its own snapshot, and its source ID includes the current orb ID so switching orbs closes Find. Registration, replacement and removal happen in layout effects so the route's source is current in the same commit (`docs/postmortems/2026-09-16-release-validation-blockers.md`). Replacing a source closes Find and clears its state.

Items (`AppSearchItem`) carry a stable source-namespaced key, kind and group labels, title, optional tile, project chip and age, explicit `keywords` (the only searchable text) and an `href`. Status is `complete`, `loading` or `partial_error` with a message. A server-backed source, if ever needed, owns its requests in its adapter and hands the shell an ordinary snapshot.

**Matching.** NFKC-normalized, trimmed, locale-independent lowercase substring match on explicit `keywords` only. No fuzzy matching or ranking. Project keywords: name, repository URL as returned, and a `github.com/owner/repo` alias. Orb keywords: display name (or `untitled orb`). An empty query shows nothing. Groups keep first-seen order and items source order: `PROJECTS` before `ORBS`, orbs in the view's working-then-archive order.

**Presentation.** A dialog with an `<input type="search">` and anchor result rows, the match `<mark>`ed (look: `docs/design-system.md`). Escape or an outside press dismisses and restores previous focus; repeating the shortcut reselects the query.

**Selection.** Exactly one active row, keyed by item key. Arrows and real pointer movement move it; redraw-induced pointer events are ignored. If the active key disappears, the first result becomes active without an unselected frame. The result region stays mounted, so results swap without flashing. Enter activates; unmodified same-tab activation closes Find, modified activation does not.

**Incomplete data.** Find indexes only loaded lists. In one polite live region it says `Searching loaded items · some orbs still loading`, or that some orbs could not be searched; it never claims no matches without that. A failed refresh drops that project's orbs from Find while the index keeps stale rows. No search cache.

**Orb-link picker.** Typing `@` in message mode (not paste or IME) opens the same dialog for orb names across projects, archived included. `OrbLinkPicker` loads a fresh index per opening with loading/partial status. Picking replaces that `@` with `https://<app>/orbs/:orbId` and puts the caret after it; dismissal leaves the `@`.

## Orb workspace

### Index

Two panes: the index and the conversation. On desktop the index is fixed to the viewport (below any session ribbon) and scrolls independently; the conversation uses its own bounded scroll pane. Phones hide the index without unmounting it.

- The first row links home.
- Every project the user owns appears as a section with the shared `ProjectHeader`. Headers stick within their section. Rows link to their orbs; the current orb is marked.
- `OrbIndex` polls all projects and orb lists every 2s without overlapping cycles. A section appears with its first settled list; one poll's lists publish in one commit, with one `loading projects…` line until then. Failed reads keep the last good rows with a scoped "list is stale" error. Mutation revisions reject polls started before a config or delete result.
- **Section priority:** sections rank by their best orb: `running` (idle or busy), then sleeping, then other working orbs, then projects with no working orbs. Base order is kept within tiers; initial failures go last. Dashboard and Find order are unaffected.
- Deleting another project leaves the conversation in place and shows that project's deletion progress with actions disabled. Deleting the current project returns to the dashboard.
- **Archive selection:** when a poll sees the selected working orb enter `archiving` or `archived` and its archive is closed, selection clears to `/orbs` and pending loads cancel; an open archive keeps the selection. The header Archive action follows the same poll path, so selection clears on the next successful list, not on API acceptance; cancelled or failed requests never clear it. Missing initial metadata is not an archive transition, and collapsing the archive around a selected archived orb does not navigate. When the selected orb enters `deleting`, the URL stays and the missing-resource path takes over. Direct navigation to an archived orb opens its archive. The empty `/orbs` view shows the index on phones.

### Switching orbs

The index stays mounted (rows, scroll, polling) across same- and cross-project switches. The selected row changes immediately and its age shows `…` with `aria-busy` while the destination loads.
- A cache miss keeps the outgoing conversation visible and inert, then swaps in one commit; a cache hit mounts the cached transcript provisionally (`docs/history.md`, "Browser transcript cache").
- No empty transcript, fade, overlay or whole-page remount. Another selection can supersede a pending one; late results are discarded; returning to the visible orb cancels the switch.
- The route shell owns loads; committed switches dispose the old socket and start the new cursor from cached or replicated history. No hidden mounted conversations or sockets. Drafts are scoped by orb ID. Cache rules: `docs/history.md`.

### Header

One sticky line of cells (layout: `docs/design-system.md`).

- Rename replaces the name with a focused form. The project name is not repeated (the index shows it).
- The state word is the lifecycle state, with `· busy` from live activity, or the preview word (`docs/http-exposure.md`).
- Model and thinking (Claude: `effort`) cells render only with current live runtime settings; clicking one opens its command picker and restores the draft afterwards. Claude effort appears only when the selected model advertises levels. Unknown settings render nothing. Settings authority and mutation: `docs/agent-context.md`.
- Unavailable groups are hidden, not left as empty cells. Terminal and Upload appear only while running; Start/Stop only when the state accepts them; Archive disables once archiving/archived; Delete disables while deleting. Rename, Archive and Delete flows: `docs/teardown.md`.
- Omitted as clutter: orb ID, state version, commit, ports, connection text, notification controls.

**Header stack.** Below the header, outside the transcript scroller, in order: share notice; required-action notice; subagent and shell rails; Links drawer (`docs/orb-links.md`); hosted Files disclosure (`docs/http-exposure.md`); upload progress (`docs/workspace-uploads.md`); lifecycle failure (`lastError`); resource warnings; drop feedback. The terminal shade portals below this stack (`docs/terminal.md`). On desktop, if the stack outgrows a short viewport, only its content scrolls; the transcript keeps two 20px rows and the composer its own space. Phones add no extra scroll owner.

**Notices.** Lifecycle, authentication and error notices appear once. A required login renders first in the header stack so tail-following cannot hide its action. The device-login notice shows the provider, the verification link, the user code with a copy icon (copies exactly `userCode`, never the URL) and `expires in 9m`; nothing once expired. Owner-login-required viewers see only that state. Initial loading and empty transcripts add no placeholder.

### Live status

**Bit register.** The live-work mark (`BitRegister.tsx`, look: `docs/design-system.md`) shows before output and at the tail of live output. It animates in CSS, with no JS timer. Assistive tech reads one stable `Agent working`.

**Busy authority** (`isLiveBusy`): running orb (any lifecycle state for central Pi) + open live connection + current busy activity that is not compaction (compaction shows its own row, not the Bit register). Any non-open connection clears activity and operation ID without discarding output or drafts; reopening alone cannot revive busy; lifecycle changes hide the mark before connection cleanup. Header and API activity derive from agent work, never guest liveness. Tests: `apps/web/src/pages/OrbPage.test.ts`.

**Subagent and shell rails** (`SubagentRail.tsx`). Separate Subagents and Shell disclosures show nonzero running/queued/finishing counts from the current operation's runtime roster (`docs/runtime-protocol.md`). They render only while the orb is running, the agent connection is live and the category is nonempty. Disconnect and resynchronization withdraw them; historical notices and parent-only activity never keep them. Expanding shows flat task-description/phase rows in a bounded scroll area; IDs are protocol keys, never content. Children without a description get a lazy Luna summary when their row becomes visible (`docs/activity-headlines.md`).

**Execution wait.** A live tool joins its persisted call card by call ID; there is no separate live chip. Until the result commits, the card shows live status and a one-line running reason capped at 160 characters plus ellipsis. Committed results override stale live state.

### Transcript

**Sources.** A stopped orb shows replicated history from the control plane. A running orb shows that history first, then attaches live updates after its cursor. Token deltas are ephemeral and rebuilt from live events after reconnect.

**Lazy display.** Records arrive as display projections and disclosures load their details on open (`docs/history.md`, "Lazy detail"). Local image formats: PNG, JPEG, GIF, WebP. Live-detail polling: only the latest owner publishes and arms the timer (Retry takes ownership even when joining a pending read); close, disconnect and navigation leave no timer. Detail failures show scoped Retry, never empty content.
- Every call has its own summary. Results pair with the preceding unmatched call by `callId`, across prose, notices and alerts (display runs still break there); user turns and compaction reset pending calls; sequential `callId` reuse is safe. Image-bearing calls and distinct clipped read paths (`targetId`) stay separate. Header and HTML `title` use the same capped label; a capped headline does not cap aggregate summaries. Initially visible images stay visible.

**Authored records.** No speaker gutter or author label; hidden `You:`/`Orb:` text keeps attribution for assistive tech.
- A user-role record is a **user turn** only when it carries an inbox receipt (`inboxMessageIds`).
- Any other user-role record (Claude task notifications, scheduled or peer deliveries, CLI-injected text) is an `agent.delivery` activity row in the orb turn, labelled `task`/`scheduled`/`peer`/`injected`, headline from `<summary>` or the first line, full text loaded lazily.

**Outstanding messages.** Each queued message appears once, in transcript position, as a queued user turn with its status (`queued`, `steering`, `paused`, `delivering`, `blocked` (`docs/inbox.md`), briefly `delivered`, `failed`). A row retires only when a local history record names it in `inboxMessageIds`; `delivered` without that record triggers a history repair that merges the replicated prefix ahead of the live suffix. Messages delivered together collapse into one user turn. All harnesses render committed content from canonical history, not inbox bodies (`docs/claude.md`).

The inbox poller (one per mounted orb, every 2s, 30s deadline, singleflight) uses the insertion-ordinal delta `POST /messages/poll` (`docs/inbox.md`). It synchronously owns both cursor and rows, including optimistic sends and retirement; React only reads snapshots. PUT never advances the cursor; navigation and mutation fences drop stale reads; failures show an inbox notice and retry without advancing (`docs/postmortems/2026-10-02-inbox-poll-payload.md`).

**Peer messages.** Trusted orb-to-orb input is a `notification` activity step. Expanding shows the full literal text, never Markdown. The sender links by orb ID, named from the current index, falling back to the ID and the normal missing page. Pending rows use `system:{kind:"orb_message",senderOrbId}`; history uses `orb.message` with `sender:{orbId}`. Every delivery state keeps sender and body; failed rows expand to the full wrapped diagnostic. Contract and wake policy: `docs/inbox.md`.

**Markdown.** User and assistant text, committed and streaming, use one GFM pipeline (`ChatMarkdown`).
- Every fence has one copy action. It copies source only: no fence, final parser newline removed, indentation and trailing spaces kept.
- Autolink-literal makes HTTP(S) and `www.` literals clickable without touching code or existing links. Custom messages and compaction summaries stay literal and go through a dedicated URL tokenizer. Generated external links open in a new tab with `noopener noreferrer`. Tool input/output is never linkified.
- `orb:` destinations resolve against the viewed orb's `filesBaseUrl`; malformed ones stay unclickable (`docs/http-exposure.md`).

**Response copy.** Each non-empty assistant response has one copy icon on its first non-empty text block. It copies raw Markdown, joining the response's text blocks with `\n\n`; reasoning, tools, images, errors and user messages are excluded. Live, each live text block is its own copy boundary; the committed record's action replaces it by identity.

**Mermaid.** A closed ` ```mermaid ` fence renders as a diagram with Source (swap to text), Open (fitted modal) and Copy actions (look: `docs/design-system.md`). Mermaid 12 loads lazily (`apps/web/src/lib/mermaid-render.ts`) with `securityLevel: "strict"`; directives must never enable script handlers or JavaScript links. Unclosed (streaming) fences stay code; parse failures keep the source with `Mermaid: parse error on line N`. Measurement uses a fixed hidden container removed afterwards (`docs/postmortems/2026-10-23-frontend-chart-qualification.md`). Renders log `console.debug("mermaid render", {outcome})`.

**Activity rail.** Reasoning, tool calls, subagent receipts and notifications in an orb turn hang on one rail (look: `docs/design-system.md`). Prose, user turns, errors and other content break it. Each row is an `ActivityRailRow` disclosure, `label · headline` with the full value as native title.
- **Single steps.** A lone tool call names the actual file or command (`read · provider.ts:180–329`); read ranges are part of the headline. A completed step with nothing else to report shows no metric. Unknown tools fall back to their name.
- **Activity strip.** Every maximal run of two or more steps (one reasoning block, tool call, subagent receipt or restart notice each) folds into one `activity` row of dots. Each dot is a button (`tabIndex=-1`) with a `label · headline` tooltip; hover generates eligible headlines (`docs/activity-headlines.md`). Clicking it opens the strip showing only that step, already open. The summary opens all steps. Opened rows stay mounted while closed so late headlines land. Open state is keyed by step identity and survives the live→history handoff. Boundaries: prose, errors, unpaired results, other custom records, delivery rows, and calls with images or charts.
- **Restart notices** (`pi-orb.sleep-wake` → `sleep finished`, `pi-orb.harness-restarted` → `harness restarted`, Claude `pi-orb.host-restarted` / `turn-resume` / `turn-resume-declined` → `host restarted` or `runtime restarted`) join the surrounding strip with label `restart`, so repeated restarts don't fragment it into alternating notice and activity rows; the expanded row is the unchanged notice. `pi-orb.restart-notification-failed` stays a boundary.
- **Every single-call disclosure** shows that call's data directly when opened, committed or live. Bodies mount only while open.
- **Reasoning** uses the same row with label `thinking`. Its headline joins all ATX/setext headings and bold-only single lines with ` · ` inside the 1 KiB bound; code, mixed prose and redacted reasoning give none. Opened reasoning renders with the shared GFM renderer, live or committed. Empty or whitespace reasoning is suppressed; open disclosures survive retirement through `detailAliases` (`docs/runtime-protocol.md`, `docs/postmortems/2026-10-06-empty-live-thinking.md`).
- **Codemode.** Parent codemode results disclose nested-call inputs, status, duration, safe errors and a bounded summary, fetched when the parent opens; incomplete or filtered summaries say so. Transient nested events never enter the root live-tools projection, so only the committed parent summary renders and live and replicated views agree without a child-history endpoint. Bash and codemode headers show the call's bounded `code` until a Luna summary is ready (`docs/activity-headlines.md`); terminal failure shows `Summary unavailable. Retry`, with manual Retry only.
- **Claude background agents.** A Claude async launch receipt (`status === "async_launched"`, `isAsync`, nonempty `agentId`, exact `tool_use_id` match, no error) is labelled `started`, meaning admitted, not finished. Foreground results stay `complete`; failed admissions `failed`.
- **Live handoff.** Live calls use the same rows and disappear once their persisted call ID exists. Live reasoning, output and tools extend the final persisted agent record when no user boundary intervenes. A committed `history.record` removes its `retiredBlockIds` in the same update; never infer retirement by text comparison (`docs/runtime-protocol.md`).

**Tool images.** Tool-returned images live in their tool's drawer, open by default; closing hides images and output and survives polls. Text-only drawers start closed. Each image call has its own header and breaks a strip. A native modal enlarges an image (focus on the modal, Escape/backdrop/X closes and returns focus). Missing data shows an inline unavailable state.

**Charts.** Agents show charts as their own transcript rows via Pi codemode `await chart(spec)` (`docs/pi.md`; the bundled `charts` skill teaches usage). Kinds and limits are in `packages/protocol/src/chart.ts`: `line` (optional per-series `band`, markers, thresholds), `bar`, `histogram`, `timeline`, `heatmap` and `compare`; at most six series and 5,000 points. Data is inline and frozen with the turn, never fetched.
- The browser builds Vega-Lite (`apps/web/src/lib/chart-spec.ts`) and renders with lazily loaded Vega 6. `Chart.tsx`, builders, renderer and CSS are shared with the usage page.
- Each chart is an open-by-default rail row `chart · <title>` after the producing call. Folded, it shows a sparkline and, for one series, the latest value (timeline: total duration; compare: `N worse`).
- Style: `docs/design-system.md`. Hovering a truncated threshold label shows the full label and value. `compare` keeps the given row order.
- Each mount owns a fresh host element that its cleanup detaches, so overlapping `vega-embed` mounts cannot leave a stale view. Mounts log `console.debug("chart render", {orbId, recordId, detailKey, index, outcome, ms|message})`; failures show `Chart failed: …` or `Chart unavailable.` inline. Invalid specs fail the script with the validation message.
- Rejected: raw Vega-Lite pass-through (no style guarantees, allows remote data) and iframed Datadog widgets (public URLs or framing refused).

**Subagent receipts** (`SubagentNotice.tsx`). Every record with a typed `subagent` receipt is an ordinary activity row naming the task description (not the child ID) and outcome. One expansion shows the structured error, result preview, progress message or workspace notice, with duration when valid; missing details say so. Model-facing XML and child transcript paths are never shown. Child alerts render as a neutral, closed row `notification · <preview>` with `description · id` at the right; the preview is the whitespace-collapsed actual message capped at 1 KiB, and expanding shows `detail.body.message` once as literal text (`docs/pi.md`). It reuses `ActivityRailRow` keyboard behavior and the detail failure/Retry path; no severity, unread flag or summary request.

**Compaction.** `/compact` and `/compact <instructions>` run native compaction (`docs/runtime-protocol.md`). The transcript immediately shows a `compacting` row styled like thinking. The first canonical compaction or outcome after the admission frontier (busy status carries `compactionAfterId`) replaces it, preserving openness. Success reads `context compacted` and lazily loads the summary; failure (`compactionOutcome: "failed"`) is a failed row; abort is neutral. Losing live authority hides progress but keeps the handoff anchor.

**Failures in the transcript.**
- An assistant record with `finishReason: error` shows its `failure.message` as plain error text at the end of the response, even when content is empty; blank details fall back to `Model response failed.` Partial output stays. It is a boundary for activity grouping. Orb `running` still only means the host is running.
- When `failure.diagnostics` contain `provider_transport_failure`, the text reads `The agent’s connection to OpenAI was interrupted.` for `openai-codex` (`the model provider` otherwise), followed by the original diagnostic.
- Repository skills skipped for invalid YAML, UTF-8, metadata or duplicate names show a reload-safe warning from durable `{path, code}` diagnostics, without content.

**Tail following** (`apps/web/src/lib/scroll-pin.ts`, `tail-follow.ts`). Within 48px of the tail, growth follows new content; a reader elsewhere keeps their place. Only geometry observation (ResizeObserver on viewport and content) writes the tail, before paint, and skips already-satisfied offsets; polling renders never write `scrollTop`.
- Release before native movement: upward wheel with an upward range, non-editable scroll keys, upward-reading touchmove (held through momentum). Retain: downward, horizontal and zero-delta wheel, stationary pointer presses, nonmoving touch cancellation, End at the tail.
- A scroll event at exactly the pending tail-write offset is the app's own write even if a press landed first (`docs/postmortems/2026-10-11-phone-tail-pointer-race.md`). Native clamp/anchor events and duplicate unchanged-offset events keep an existing pin; resize reconciliation keeps the previous pinned geometry. Window pointerup/pointercancel clears pointer tracking even outside the pane.
- Edges log `scroll_pin` debug entries with reason and pixel geometry.

**Older rows.** Tail-first mounting of grouped rows: `docs/history.md`.

**Render cost.** `OrbConversation` memoizes history, live and tool arrays by reducer-map identity and `HistoryView` is shallow-memoized, so typing never rerenders the transcript. Unchanged inbox rows and same-session history records keep their identity across polls and repairs (`docs/postmortems/2026-09-20-composer-typing-stalls.md`).

### Composer

Sticky at the bottom of the transcript column. One row: the mode prefix (`>` message, `/` command), the textarea (vertically resizable, `aria-label` `Message the orb`), and the `x` abort icon while an operation can be aborted. Attachments sit above, unindented.

- **Sending.** On desktop ⌘⏎/Ctrl⏎ is the only send gesture; a pending request shows nothing. Message mode stays enabled while busy, starting, stopped or failed (the durable inbox accepts it; `docs/inbox.md`); archiving and archived orbs render no composer (read-only history), and deleting orbs reject input. The composer clears only after the durable HTTP `202` or WebSocket acceptance, and only if text, mode and attachments still match the submitted snapshot; otherwise the whole current draft survives.
- **Drafts.** Non-empty text, mode and image attachments persist per orb in principal-scoped `sessionStorage`; storage failures appear in the notice surface.
- **Commands.** A leading `/` typed at position 0 is consumed and switches the prefix to `/`; Backspace in an empty command returns to `>`. Commands are `model`, `thinking` (Claude: `effort`) and `compact`. Typing filters commands then values; arrows select, Enter/Tab choose. One Escape or an outside click dismisses the picker. Unknown commands never send as messages. Header-opened pickers restore the prior draft; on touch, choosing a value applies the setting rather than sending. Bangs are literal text.
- **Images.** Paste or drop images to attach them to the draft; non-image drops are rejected (`docs/workspace-uploads.md`).
- **Mentions.** `@` opens the orb-link picker (Find above).
- **Caret.** The native caret. The textarea owns editing, selection, IME and reveal-scroll. Rejected: a mirrored overlay caret (intermittently invisible in the Safari Dock app; `docs/postmortems/2026-09-19-composer-caret-ordering.md`) and `caret-shape: block`.
- **Focus.** On non-touch desktops the textarea gets focus on arrival and when the tab becomes visible again, without scrolling; submitting keeps focus. Devices with any touch capability (including desktop-width tablets) never get unsolicited focus; viewport width describes layout, not input. Open dialogs keep focus.
- **Abort** sends the exact current operation ID through the existing admission path and retains the draft. On central Pi with no current operation, it targets the first queued human message as `inbox:<UUID>` (`docs/inbox.md`).
- **Command admission** (`canRunComposerCommand`): settings and `/compact` require a writable-settings, synchronized open connection, idle activity, no children, no compaction and no pending request (running lifecycle unless central Pi). Enter or touch runs `/compact` directly.

### Phone layout (≤600px)

- The viewport keeps device width and initial scale 1 and allows pinch zoom.
- The index is hidden; a back icon links to the dashboard. Header actions fold behind an `Orb actions` overflow toggle into a second row, including Terminal; the state tile stays visible and the state word stays accessible.
- The composer starts collapsed, unfocused: one row (plus top rule and safe-area inset) showing the prefix and draft text or image count, with the X abort beside it when abortable. Tapping opens the same textarea in place beside Fold and Send. No modal, title, scrim or editor abort. Fold and Escape keep the draft; Return inserts a newline. Send uses normal submission; after acceptance the editor folds and releases focus (editing after sending cancels that). Request feedback appears next to the composer.
- **One scroll owner.** The app is a fixed box at the visual viewport's top and height (`useVisualViewport`, `apps/web/src/lib/use-visual-viewport.ts`, at every width). Document scroll is locked; header and composer are non-sticky flex siblings; only the transcript scrolls. The session ribbon takes space inside that box. `interactive-widget=resizes-content` is a hint, not a dependency (`docs/postmortems/2026-09-12-mobile-safari-scroll-ownership.md`).
- The viewport is resampled on resize/pan and on visible `visibilitychange`, `pageshow` and window `focus`, so stale geometry cannot strand the composer. Changed geometry on those edges logs a `viewport` entry. No timers, forced scroll or remount. Pinch zoom keeps the last unzoomed measurement.
- Using the visual viewport at every width also keeps iPadOS's floating input-assistant bar from scrolling the app's top away.
- **iPhone keyboard accessory.** With the textarea focused at phone width on iPhone/iPod and the visual viewport more than 150px shorter than `innerHeight`, the composer reserves 60px bottom padding (or the safe-area inset if larger) for the Previous/Next/Done pill. Fold and enabled Send prevent primary mousedown focus transfer so the reserve holds until click. The `viewport` trace adds `viewportLayoutHeight`. Rejected: cancelling pointerdown (WebKit drops the click), forced scroll, polling, replacing the textarea.
- Physical-device verification is tracked in `TODO.md`.

### Home-screen app

iPhone and iPad can install pi-orb via Safari's Add to Home Screen (`README.md`) as an online-only standalone app. The static manifest uses `/` for identity, scope and start URL, so installing from an orb never pins it. Name `pi-orb`; white theme. Opaque 180/192/512px PNG icons rasterize `apps/web/app-icon.svg`. The manifest is linked with `crossorigin="use-credentials"`; manifest and icons are public. No service worker, offline cache, push or install prompt. The installed app may need its own sign-in.

- **Status-bar band.** iPadOS blurs content under the clock unless a fixed element with a background colour spans ≥90% width, is taller than 10px and sits at the top. `index.html` carries an empty `aria-hidden`, `pointer-events: none` 12px full-width band at `top: 0`, a paper `background-color` with `background-clip: text` and maximum z-index: it qualifies without painting.
- **External links open in Safari.** In standalone mode with `navigator.maxTouchPoints > 1`, `apps/web/src/lib/safari-links.ts` (one capture-phase click listener) sends unmodified primary clicks on other-origin `http(s)` links to `x-safari-<href>`. iOS's in-app sheet has its own cookie jar and broke hosted-file sign-in. Rejected: rewriting hrefs per component.
- **Auth handoffs** use the same guard: Claude consent (`docs/claude.md`) and MCP Connect (`docs/mcp.md`). Google login stays same-tab.

## Settings

**Dialogs.** Initial focus uses `useInitialFocus` with a stable ref and never depends on changing callbacks, polls or saving state; Escape and outside-click listeners have separate lifetimes. Backdrop clicks never discard drafts.

**Owner Settings.** The dashboard gear opens the Settings dialog: Instructions / Skills / Secrets / Git / Claude (`ConfigTabs`, arrow/Home/End). Instructions opens first. Panes stay mounted; drafts survive tab switches and close/reopen in dashboard memory and are lost on reload or leaving the dashboard. Inactive panes leave the focus trap. Close restores gear focus. Tab contents: `docs/agent-context.md`, Claude `docs/claude.md`.

**Project Config.** The project gear opens Config, portaled outside the index's sticky layout, with General / Instructions / MCPs / Secrets tabs, General selected (MCPs when opened via `/projects/:projectId/mcp`).
- All panels stay mounted; switching tabs keeps every draft, including partial MCP and secret fields. Drafts live in component memory and are discarded on explicit close or project change, never in browser storage.
- Save/fetch/remove disable tab switching and closing until done; errors stay in their panel with the draft. While disabled, focus stays on the dialog. Initial focus is the selected tab; polls and requests never move it. Escape and close return focus to the gear. Configuration is disabled once project deletion starts.
- **General** edits the project name and repository URL (not orb names). A blank repository saves null; nonblank URLs run the shared validator and invalid input disables Save with the specific error. The server commits both atomically. Success updates the header and page title at once. Repository changes apply to new checkouts.
- **Instructions**: `docs/agent-context.md`. **MCPs**: `docs/mcp.md`. **Secrets**: `docs/credentials.md`; its Sealed card has write-only copy, a password input, an accessible dialog and a non-action backdrop, preserves failed writes and owns Escape/focus.
- `/projects/:projectId/mcp` opens Config on MCPs over the live dashboard; closing navigates to the focused project without remounting. A missing project keeps the URL and shows the project not-found page.

## Session and sign-in

The app uses Google login with sealed session cookies (`docs/auth.md`).
- **Session ribbon.** After a browser API 401, an app-wide ribbon says `sign in required` with **sign in**. Until a validated `GET /api/v1/session` probe succeeds, other API calls fail locally without a request (a stale tab once polled ~2 requests/s of 401s). Window focus and suspicious socket closure trigger a bounded probe; request ordering prevents stale success from clearing a newer failure. Sign in navigates the same tab to `/auth/login?returnTo=…` with path, query and hash. Rejected: opening a second app tab (the original stayed expired).
- After the round trip the same user's composer drafts come back from `sessionStorage`.
- **Sign out** appears in the dashboard footer only when the session reports `logoutAvailable: true` (Google cookie sessions). It posts `/auth/logout`, disables while pending and shows failures. Success clears the principal, private state and drafts and unmounts the private app, closing its sockets. It clears this browser's cookie only; copied cookies stay valid until expiry and other tabs notice on their next request or focus probe.
- Principal-generation fencing stops late responses (JSON, history/detail bodies, images) from restoring a previous user's UI.

**Failure placement.** One typed transport boundary classifies auth, offline, timeout, HTTP, invalid-response, socket and cancellation failures. The owner shows the outcome: auth app-wide (ribbon), a mutation's error beside its control, a failed initial read on the page, polling or socket trouble as stale/reconnecting without repeated banners. Timeouts say the outcome is unconfirmed; retries reuse the message ID and body. Rejected: toasts (detached, missable) and a global error queue (only the owner knows how to recover). Remaining coverage: `TODO.md`.

## Frontend development

Two Docker-free compositions; do not confuse them.
- **Full service with process-hosted orbs:** `npm run dev:local` (control plane, PGlite, process supervisor) plus `npm run dev --workspace @pi-orb/web`. Real central Pi, runtimes, lifecycle, history, credentials and inference; repository code runs unsandboxed (`docs/host-provider.md`). Local mode trusts only loopback Vite origins; another hostname (e.g. a tailnet name) gets 403 unless `PI_ORB_APP_ORIGIN` is that exact origin.
- **Frontend-only fixture:** `npm run dev:frontend` starts only Vite in `frontend` mode, with no database, control plane, runtime, credentials or models. Inside an orb, `pi-orb expose 5173` shares it; Vite allowlists `.piorb.live` because previews authenticate first.

The fixture is a transport-level adapter injected by the Vite plugin, not a React mock: production UI calls the same relative URLs, validates the same `@pi-orb/protocol` schemas and runs the same reducers, so protocol drift fails visibly. It owns `/api/v1` and the agent and terminal WebSocket upgrades. State is process-local; restarting Vite resets it.
- Seeded orbs cover the transcript features (Markdown, images, tools, receipts, long history, lazy details, charts, `frontend-diagrams`, `frontend-activity`, `frontend-sticky-bars`), a device-login challenge, an archived orb, and projects with stopped, failed and no orbs. Messages get a streamed echo, the terminal a deterministic echo; lifecycle, creation and abort use the real browser contracts. New orbs stay `creating` for about 10s. MCP and OAuth are simulated.
- `PI_ORB_FIXTURE_ORB_NESTING=1` nests Long history and Transcript charts under the playground orb, and Lazy details under Long history.
- `PI_ORB_FIXTURE_TIMESTAMP_CHURN=1` rotates fresh `updatedAt` values on every list request, to check that ages update without rows moving.
- A lower-right **frontend fixture · session active** control (hidden at phone width; not in the production build) has **expire session** (closes fixture sockets; every `/api/*` returns a synthetic HTML 401) and **restore session**. It dispatches a window focus so the real `SessionRibbon` probes. The fixture login route restores the session and returns to the same path.

**Restart rule.** After changing the fixture backend or shared protocol, fully restart the frontend process; Vite's config reload can keep old protocol exports in Node while HMR loads a new client. Check the process's logs and smoke-test the change on that exact service; a fresh instance on another port proves nothing about a long-running preview (`docs/postmortems/2026-09-09-stale-frontend-preview.md`).

**Static builds.** The service registers `PI_ORB_WEB_DIST` asset routes at startup, so never rebuild that directory in place (appending hashed assets and swapping the index does not help either). Use Vite for iteration, or point a restarted service at a completed separate build after checking active runtimes and auth helpers. Validate every referenced asset's status and MIME type and the rendered page, not just a 200 for the index (`docs/postmortems/2026-09-09-live-web-rebuild.md`, `docs/postmortems/2026-10-04-claude-management-assets.md`).

Browser test suites and their commands: `docs/testing.md`.
