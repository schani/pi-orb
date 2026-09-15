# Agent settings and lifecycle-cluster header

**Status: implemented and locally qualified, 2026-09-14.** The user approved the simplified design and required DST/tests first. Lifecycle cluster, the title-free anchored picker, live-only settings display, idle-only mutation and last-applied-wins are selected; `docs/open-questions.md`, agent-settings question 62 is resolved. Initial implementation was qualified without deployment. The user subsequently authorized pushing to `main` and dispatching the production GitHub Actions Deploy workflow (2026-09-14); its release transaction reruns checks and full Docker-backed E2E before applying. Typecheck, lint, unit/DST/infra and full process-backed E2E pass locally; exact coverage and platform skips are recorded in `docs/testing.md`.

## The smallest useful design

**One authority, one state event, two commands, one short mutation guard.** Pi owns persistent settings; the runtime exposes the effective pair and catalog; the browser renders it. No database changes, settings file, settings inbox, per-project defaults, or new reconciler.

### Product behavior

- Settings belong to the orb/session and survive restart. Fresh sessions use the existing Astra/high defaults; resumed sessions restore their recorded choices before boot notifications or interrupted-turn resume can issue inference.
- Offer eligible image-capable conversation models from the existing brokered `openai-codex` catalog, excluding internal Luna. This preserves the existing image-input promise. The prototype's Anthropic names are not available providers.
- The runtime supplies supported thinking levels from SDK metadata, including holes or `max`. Model changes retain the current level where supported and otherwise clamp using the SDK; explicit unsupported thinking choices reject. Show an adjustment only when one occurred. Same-value selections are no-ops.
- Apply only when running, synchronized and idle. No queued-next-turn changes or automatic wake. Busy rejection is visible next to the picker.
- Multiple tabs use **last-applied-wins for explicit requests**, not optimistic-concurrency revisions. Concurrent requests while a setter owns configuration reject busy; a later explicit request can overwrite an earlier selection, and every tab sees the result. Each command sets only its own field, so an old thinking picker does not resend an old model. Model-induced clamping remains runtime-owned.
- On disconnect, clear the live settings/catalog and show `—` in disabled cells until synchronization. Stopped/archived pages also show `—`. **Tradeoff:** no last-recorded settings display in this slice. The settings remain stored in Pi and restore on Start; the browser simply does not implement a second read path.

## What changes in the code

### 1. Restore and persist settings correctly

`apps/orb-runtime/src/pi/agent.ts` formerly passed `pickCodexModel(...)` on every creation and then forced `setThinkingLevel("high")`. It now restores explicitly; only absent settings use defaults. Do not use the last assistant response's model as current configuration. Do not alter Luna's separate fixed model policy or Pi's global defaults.

**SDK finding and smaller implementation:** `SessionManager.create()` is lazy until the first assistant, but the public `setSessionFile()` path initializes an existing empty file eagerly. `pi/settings-persistence.ts` creates a manager, exclusively reserves its generated path (`wx`, mode 0600), then passes that empty file to the SDK. Pi writes and owns the header/entries and sets its own flushed state. No SDK patch, private fields, serialized header written by pi-orb, phantom assistant, or second settings file is needed. `syncSessionFile()` fsyncs the actual session file and parent directory before startup/settings success. Existing persisted sessions open normally. The generic unflushed gate remains valid for lazy SDK sessions and tests; eager production sessions pass it.

Real-SDK contracts prove native setters → file sync → reopen **without any assistant response**, unchanged entry/session IDs, one header, and subsequent eager appends. A second finding: SDK automatic restoration uses the presence of messages, not merely saved settings. `pi/restore-settings.ts` therefore explicitly resolves model and thinking from the full session path before `createAgentSession`, including settings-only sessions. This replaced the old regex test requiring an unconditional `high` reset. `LiveHistoryPublisher.flushPersisted()` remains a publication helper, never a disk-flush API.

If a restored model disappeared, reuse the safe default selection, persist the actual change, and add one visible durable diagnostic explaining the fallback. A necessary restored-thinking clamp is likewise recorded. Healthy restarts log no edge. No eligible model or uncertain persistence means failed readiness, not silently usable settings. Transient auth failure is not a reason to switch models.

### 2. Expose one authoritative runtime view

Add one ordinary `runtime.event`, used both live and inside the existing synchronous hello batch:

```ts
type AgentSettingsEvent = {
  type: "agent_settings";
  settings: { model: { provider: string; id: string }; thinkingLevel: ThinkingLevel };
  models: Array<{ provider: string; id: string; name: string; thinkingLevels: ThinkingLevel[] }>;
  writable: boolean;
};
```

`ThinkingLevel` is the shared validated SDK-supported vocabulary, not the prototype's hardcoded rows. Build the catalog locally at runtime initialization; opening the picker makes no discovery/auth call. Actual auth is checked at mutation. This view belongs in `HarnessSnapshot` / `computeSyncFrames`, including caught-up reconnects. No separate fetch, poll, event sequence, settings revision or catalog revision.

The header follows this event only. History still replicates existing native settings entries for durability/forensics, but there is **no new history schema, offline projection, backfill, or browser Pi-overflow parsing**. HTTP replica refresh cannot overwrite header settings because it never supplies them. Connection lifecycle clears availability; completed sync restores it.

During a mutation, report the last stable pair with `writable: false`. After persistence, publish native history and the complete effective pair, then send the requester a receipt. Catalog/level metadata travels with the same view. `writable` describes configuration health/pending work; running/idle/synchronized gating uses the existing lifecycle/status view separately. SDK events and snapshots observe effective changes outside the browser setter and publish after persistence, never during a pending/failed mutation. The real-SDK contract verifies its thinking-change event, while DST verifies stable observation/publication. Direct arbitrary writes to SDK internals are not a supported settings API; there is no generic extension mutation framework.

### 3. Two explicit commands through existing request delivery

Add `set_model {model: {provider, id}}` and `set_thinking {thinkingLevel}` to `ClientAction`. Neither has `expectedHeadId` or `expectedSettingsRevision`. Add an operation-free `settings_applied {duplicate}` success variant alongside existing results. The receipt is not another settings snapshot; it never updates the header. Reuse existing rejection codes (`busy`, `invalid_request`, `unsupported`, `internal`, `request_id_conflict`) with specific user-visible messages and typed adapter errors.

Keep existing request IDs and incarnation rules. Extend the existing registry to represent an async request in progress: identical retries join the original result; conflicting payloads reject. Completed duplicates replay the receipt without reapplying state. A runtime restart drops automatic replay and synchronizes actual persisted settings. Last-applied-wins applies to **new explicit requests**, never to replaying old intent after restart.

### 4. One small guard at agent admission

The current WS handler is synchronous, not an async serial executor, and HTTP inbox delivery enters the agent separately. Claim a configuration-in-progress guard **inside the agent before the first setter await**. Settings, live message/shell and HTTP inbox admission check it. Boot input retains the existing synchronous final attachment step: restoration/persistence finishes first, then any automatic turn claims the existing turn-start barrier before readiness can be observed by another ingress. There is no asynchronous gap in which a settings request can precede that boot claim, so no separate boot/settings queue is introduced.

- Already busy/turn-start-reserved/configuring: reject a new settings request visibly.
- **Subagent integration (2026-09-15):** idle-stop/archive preparation declines while settings ownership remains, including uncertain late setters. Once preparation succeeds, settings admission is fenced along with ordinary work. Settings do not create an agent operation or retain the active-child rail. New child admission also rejects during configuration, so child completion cannot trigger root inference on a partially applied settings pair. Both fence admission orders and the child guard are covered by `pi/settings-idle-stop.dst.test.ts`; explicit Stop still has interruption authority.
- Configuration owns admission: reject live starts; return the existing retryable result to HTTP inbox delivery so its durable message stays queued at the control plane. Do not classify it as a steer without an agent turn.
- Apply setter, explicitly enforce model/thinking policy, read actual SDK state, persist, publish, record/send receipt, release ownership. No guard held across a whole agent turn and no queue of settings changes.
- The requesting browser blocks Send while its settings outcome is unresolved. Across different tabs/transports, runtime admission—not CP message acceptance time—decides ordering.
- Stop retains its existing lifecycle behavior and can interrupt this short mutation. It is not Abort and is never followed by a settings-triggered wake.

First-party APIs return typed `neverthrow` results; SDK throws/rejections are caught immediately. A setter may reject after mutating memory or writing one native entry. The implemented policy fails readiness in that case; publishing a known persisted result with an extension warning was considered but rejected for this slice because it requires classifying arbitrary post-mutation hooks. No compensating rollback state machine. A timeout does not prove a setter stopped; do not release ownership for new input while a late setter can still mutate it. Use bounded adapter waits and the existing unhealthy-runtime recovery path.

Native model and thinking entries are not a crash-atomic pair. We promise no false successful save and no inference on a half-applied live mutation, not that a lost reply proves the old settings remain. Reopen the persisted prefix and normalize before readiness. Failure diagnostics reuse existing durable runtime/lifecycle paths; ordinary successful edits are already recorded in native settings history. Authentication failure proven to precede mutation is marked `unchanged` and releases the guard. A thrown SDK setter, write failure, or deadline makes readiness fail and keeps input blocked even if a late setter eventually resolves. The implementation deliberately uses this conservative fail-closed path rather than attempting to classify/roll back arbitrary post-mutation hook failures. A fallback is a non-model-context Pi custom entry mapped to visible `agent.settings_fallback` history; normal settings records remain hidden.

### 5. Implement the selected UI

Header order: **name + rename | lifecycle + Start/Stop | model | thinking | terminal + upload | archive | delete**. Retain existing action callbacks/conditions, SVGs, 24px desktop geometry and divided project strip. Hide unavailable action groups rather than leaving empty cells. Abort stays in the composer.

Add `command` to the existing composer modes. A leading `/` is consumed into the prompt; only `model` and `thinking` are recognized. The anchored picker has no title/back row. Enter/Tab/touch choose; Escape dismisses the entire picker in one press (including when a menu option has focus); Backspace on empty exits. Clicking/tapping outside the picker and its text input also dismisses it without consuming the outside action. This supersedes the initial Escape-to-command-root behavior (user decision, 2026-09-14). Dismissal restores a header-initiated draft and never cancels an already delivered settings request. Literal slashes within prose/shell, IME, normal multiline input and Shift-Tab retain their meanings. Command text never enters the message inbox.

Header editing preserves the draft, mode and images. Pending state keeps confirmed header values; rejection preserves input and shows a specific error next to the picker. Dismissing a delivered request cannot cancel it or hide its eventual failure. Late completion cannot clear a newer draft. Existing request-lost feedback handles restart ambiguity. Desktop changes must preserve phone Side rail and viewport ownership; touch command selection applies the setting rather than sending a message.

## Focused test plan

Three layers, not separate bespoke suites for every edge:

1. **Real SDK contracts.** Fresh-session save/reopen before first response; restoration through compaction/restart; model-induced thinking changes/capability holes; auth and partial write/hook failures; supported settings-event observation. Read/reopen actual files, not regex assertions. These qualify the fake SDK/persistence boundary used below.
2. **One composed DST suite.** Exercise production request registry, admission guard, agent, sync/outbound and browser reducer with injected SDK/auth/disk/transport. Named checkpoints bracket claim, each setter/native append, durability, publication, result delivery, hello and process restart. Disk survives restart; pending ownership/registry do not. Cover:
   - settings versus inbox/live message/shell/boot input; no inference during configuration;
   - two tabs and in-flight/completed duplicates; one application per request, correct last-applied-wins;
   - disconnect/reconnect during mutation, delayed receipts and slow outbound delivery; no optimistic or regressed header;
   - crash between writes or after persistence before reply, including before the first turn; no false success or cross-incarnation replay;
   - setter/auth/write failure, late completion after timeout, and Stop; no premature admission or automatic wake.
   Reuse existing production-domain simulation patterns, control timers explicitly, and preserve/replay failing traces before any fix.
3. **Browser/runtime E2E plus UI units.** Change settings, assert the actual mock-Codex request's model/reasoning, reconnect with no history delta, and Stop/Start then assert restoration. Include one busy failure and one lost reply; synchronize Luna/boot consumers explicitly. Component/reducer/Chromium/WebKit coverage handles slash keys, touch, drafts/images, unknown commands, two-tab updates, disabled disconnected cells, and lifecycle-cluster/phone/terminal/upload regressions.

Implemented test files include `pi/settings-persistence.contract.test.ts`, `pi/thinking-policy.test.ts`, `domain/agent-settings.dst.test.ts`, web `pages/agent-settings.dst.test.ts` (real PiOrbAgent admission + registry + outbound/sync + reducer), `pages/agent-settings.test.ts`, command/fallback unit tests and Chromium/WebKit `e2e/agent-settings-frontend.e2e.test.ts`. The existing full-slice E2E now changes settings before first inference, checks duplicate receipts cannot reapply old intent, asserts the actual Codex request model/reasoning, and checks both Stop/Start and compute-replacement inference restoration. The former empty-history replacement assertion now waits for initial metadata replication and requires prefix preservation plus only unchanged model/thinking bindings and silent boot-baseline additions. SDK initialization re-appends settings whenever the session has no messages, even when restoration inputs are supplied; the real-SDK contract pins that behavior. Eager persistence makes those previously memory-only records real. We retain native history instead of filtering/re-IDing those bindings.

Run `npm ci`, managed browser installation, repository checks and **full `npm run test:e2e` before deployment**. DST does not replace the real SDK or browser↔runtime handshake. Any flake blocks release until root-caused, not until a passing rerun. Implementation dependencies: persistence contract → runtime view/guard/commands with DST → header/picker → end-to-end restart qualification. Work items live only in `TODO.md`.

## What was removed from the first plan, and why

- **Settings-specific revision/CAS and stale-picker workflow:** unnecessary for this single-user first slice; explicit serialized assignments can be last-applied-wins. Tradeoff: no stale-tab overwrite warning. Async request deduplication remains necessary and is not the same problem.
- **Normalized history fields and offline projection:** a second frontend settings read path is not needed to edit a running orb. Tradeoff: no settings values on disconnected/stopped/archived pages. Native history/restoration remains intact.
- **Settings values duplicated in success receipts:** ordered events already provide them; old receipts must not regress state.
- **New settings-specific rejection taxonomy:** existing wire codes plus typed adapter errors and precise messages suffice.
- **Generalized extension coordination and dynamic catalog work:** qualify the supported SDK hooks/catalog actually used, not a new extensibility subsystem.
- **A broad standalone testing program:** concentrate schedules in one production-composed DST suite, backed by narrow real-SDK contracts and the existing E2E slice. Persistence, input ordering and failure truthfulness remain non-negotiable.

Still rejected: browser/localStorage authority, CP settings reconciliation, prompts masquerading as commands, optimistic success, blind cross-restart retry, silent boot resets, fake assistant messages and a shadow settings file. No backwards-compatibility machinery is needed for this POC.
