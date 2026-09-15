# Raw subagent notifications in the web transcript — 2026-09-14

## Observation

Process-host preview on port 7200, source `e2635e1`, orb `ad70e4c1-93fb-49ef-8a10-ecbf22a5c3c6`: after the parent's final line-count answer, three large `<task-notification>` blocks appeared, each followed by an assistant acknowledgement that the failure was already handled. Read-only investigation used replicated root history and the pinned extension source; no runtime was restarted or steered. Private history evidence remains in `.context/subagent-notification-incident/` and is not exported.

## Recorded sequence (UTC)

- 22:04:00–22:04:21: four background children failed with `Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.`
- 22:04:22: the parent collected only the first failed child (`12927817-33ff-4d5`) through `get_subagent_result`.
- 22:04:30–22:05:14: the parent launched four replacements using `openai-codex/gpt-5.3-codex-spark`, then collected their successful results. One replacement was subsequently resumed to reconcile a discrepancy.
- 22:06:31: the parent published its final answer. The three uncollected failures (`156d2beb-8913-46b`, `7ff8b957-2abb-4af`, `c8c9457f-8901-4d0`) arrived as separate custom messages at 22:06:31, 22:06:34 and 22:06:36. Each prompted another short assistant reply.

## Mechanism

The extension's `NotificationManager` withholds completion announcements while the parent run is active. At settlement it rechecks each record's `claimed`/`consumed` state, drops already-collected results, and emits the remaining announcements as `subagent-notification` custom messages with `display: true`, `deliverAs: "followUp"` and `triggerTurn: true`. Replacing a child with a separately launched child does not consume the old child's result. The three notifications were distinct old failures, not duplicate history replication, new failures or automatic child replay.

The extension registers `createNotificationRenderer()` for its terminal UI. The browser does not use that renderer: `HistoryView.tsx` renders displayed custom messages through `PlainChatText`. Consequently the model-facing XML, transcript-file pointers and collection instructions are printed literally. Structured `native.details` already contains the description, status, error and bounded result preview; child transcripts need not be read or replicated to render these notices.

## Terminal renderer inspection (2026-09-14)

Direct reuse is possible with an adapter, not a React import: the registered renderer returns a Pi TUI `Text` component whose `render(width)` produces terminal text lines with ANSI styling. The SDK exposes the callback through `session.extensionRunner.getMessageRenderer(customType)`. The browser currently receives data, not rendered component output; no such bridge is implemented.

A local probe bundled the pinned `renderer.ts` with its source alias and invoked it on the recorded failure details with an unstyled theme. Collapsed output was `✗ Count runtime-api code lines error`, followed by `↻2 · 0.6s`, `⎿  No output.`, and the full local transcript path (which wraps over several lines). Expanded mode replaces the one-line/80-character result preview with up to 30 preview lines; it still prints the path. For this error there is no substantive expanded content: the renderer never reads `details.error`, so the actual unsupported-model reason is omitted even though it is persisted. This limits faithful reuse as a complete error presentation; it does not make reuse impossible. Rendering changes alone would not remove the separately triggered parent acknowledgements.

## Outcome

The initial investigation changed neither presentation nor delivery. Subsequently, the user selected N1 receipts + C2 active-only rail and P1 above the terminal shade. The local implementation now renders these structured root details, including actual errors, with no machine XML or private transcript path in the receipt (`docs/web-ui.md`). Inspection of the same stopped preview orb confirms three readable failed receipts and no live rail. The web rendering gap remains distinct from deferred/unconsumed completion semantics: no failures, native records or parent acknowledgements were discarded, and notification delivery was not changed. Qualification: `scripts/subagent-liveness/evidence/live-rail-2026-09-14.md`.
