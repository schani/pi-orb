# Local subagents

## Ownership

Generic Durable children inherit ordinary configuration, with no profiles; a model selector was added 2026-10-13 (below). Root and children expose only `codemode` while authorized internal catalog functions remain callable. Required resources precede the first turn; bundled skills and managed context are inherited through the candidate resource boundary (`docs/pi-durable-evaluation.md`). Native terminal results distinguish completion, failure and abort. `Harness.close()` suspends unfinished tasks; an admitted explicit root abort can terminally cancel root/child work. Focused real PostgreSQL/PGlite proof does not imply all Stop calls terminally cancel persisted tasks or fabricate assistant-abort transcript records (`docs/testing.md`).

**Central process outcomes (2026-10-03):** generic children inherit ordinary configuration, with no profile types. Results distinguish `completed`, `failed` (with durable failure detail), and `aborted`; steering a terminal child returns an explicit error.

## Child tools

Durable owns child conversations. `subagent({prompt,description?,model?})` returns `agent_id`; `steer_subagent({agent_id,message})`, `get_subagent_result({agent_id,wait?})`, `list_subagents({})` and `cancel_subagent({agent_id})` provide coordination. Children inherit pinned context and authorized tools, share the checkout and may edit it. No profiles or workspace-management policy. They count toward aggregate busy and whole-operation cancellation. Root receipts are public; private child transcripts have no viewer or separate replication contract.

**No nested children or orbs (decided 2026-10-13):** only the root can start subagents or spawn orbs. Orb `217632b5-d323-43c8-910a-b261f2b83301` showed one direct child while seven were running: each child inherited the root's codemode, whose description inlined all five subagent tools, plus the system-prompt line "Subagents support start, steer, observe, wait and cancel." Children now select `orb.child-tools` instead of `orb.tools`; its codemode uses the root catalog without the subagent tools and `orb_spawn`, so they are neither described, discoverable nor callable. The root never selects `orb.child-tools`. Removed for everyone: that system-prompt line, the line enumerating the `orb_*` tools (codemode already describes them), and codemode's `searchTools('subagent')` discovery example (2026-10-03 guidance decision above). `subagent` tells the root children cannot start subagents or orbs. Inherited user/project instructions and the runtime environment prompt may still mention subagents. A local child that was given only `orb_spawn` misreported it as "creating subagents", which prompted hiding `orb_spawn` too.

**Child instructions (decided 2026-10-15):** central children inherit the parent prompt plus `You are a subagent. Do not spawn orbs.` Children retain the pinned parent context and suffix; orb roots do not receive it.

**Model selector (decided 2026-10-13):** `subagent({prompt,description?,model?})` takes `Astra`, `Sol`, `Terra` or `Luna`, the conversation picker's names (`SELECTABLE_CODEX_MODELS`); omitted inherits the parent's model. An unavailable model returns `Model unavailable: <name>` before any child is created. The receipt and `get_subagent_result`/`list_subagents` report the selected name. The schema enum rejects other values, so no provider/model ID path exists.

**Notification tools (decided 2026-10-17; local, undeployed):** local children alone have `notify_parent({message})`; only roots have `orb_alert({message})`, which alerts the user. Separate catalog views enforce inline descriptions, discovery and native/nested calls, including reattachment; wrong-conversation execution also returns a typed rejection. Children share the root filesystem. `orb_send` instead addresses another agent in an independent orb without a shared filesystem (`docs/orb-messaging.md`). No new persisted state; parent steering, admission fences, receipts and wait interruption remain unchanged.

## Parent input during completion waits (decision 2026-10-14; implemented locally, not deployed)

Native child `notify_parent` retains trusted JSON parent steering and durable acceptance. **Selected 2026-10-14; implemented locally, not deployed:** its placed entry also projects as an existing notification receipt, with actual message preview and full plain-text details, no unread flag or private child-transcript access (`docs/orb-alerts.md`, `docs/history-replication.md`). Root/CLI alerts and legacy completion/update notices are unchanged.

`get_subagent_result({agent_id,wait:true})` yields on **any pending parent steer**, including human input, another child's notification, or an authenticated peer orb message (decision 2026-10-16), not only input from the child being observed. Already-pending input and input arriving during the wait both qualify; `followUp` remains unchanged. Peer steering retains its non-human/non-consent provenance (`docs/orb-messaging.md`).

The parent inbox uses atomic snapshot-and-watch registration to prevent lost wakeups; this is not a simultaneous atomic observation of child state and inbox state. Pending steer triggers a child reread: if already terminal, return its actual receipt; otherwise return a normal result with `status: "running"` and `interrupted: "parent_input"`. The wait neither consumes the parent input nor cancels the child; native delivery retains authority.

**Scope:** no code-mode propagation. The nested wait returns its interruption result to the script; the script must finish before parent inference resumes. An outer script may keep running or wait again. This decision does not qualify prompt responsiveness through arbitrary code-mode scripts.

**Local qualification:** `subagent-wait.test.ts` covers typed boundary failures and unchanged followUp/nonwait; `subagent-wait.dst.test.ts` covers native Session buffering and 190 schedules for atomic acquisition, parallel observers, terminal precedence and caller cancellation. `subagents.test.ts` covers actual ChildAnchor survival and inbox preservation. `durable-process.e2e.test.ts` covers normal codemode continuation and a later child receipt. RED traces were replayed before production edits and retained in `.context/subagent-wait/summary.md`; consolidated qualification is indexed in `.context/subagent-notify/consolidation-map.md`. Current notification qualification and incomplete full-suite scope remain in `docs/orb-alerts.md`.

## Activity, cancellation and recovery

Silent child-only work remains busy through owned cleanup and result handoff. A root result alone cannot grant idle. Operation/child identity fences obsolete observations; cancellation remains active until owned execution drains. Explicit Abort terminally cancels admitted root/child work; Stop suspends persisted work for authorized recovery, rather than promising terminal cancellation. Unsafe interrupted effects are not automatically replayed. Native completed callback receipts are reusable, not proof of physical exactly-once effects.

The active roster is display data, not drain authority. Reconnect starts unknown until a fresh snapshot; historical receipts cannot restore live activity. Queued and finishing holds remain visible until release. Supplied descriptions win; absent descriptions use committed root task metadata and bounded Luna headlines (`docs/activity-headlines.md`).

Durable root facts and lifecycle edges retain admission, terminal outcomes, cancellation and recovery disposition without exposing child prompts/transcripts. No healthy polling logs. Archive seals public history before private state/workspace cleanup; deletion owns all child resources (`docs/history-replication.md`, `docs/lifecycle.md`).

## Validation

Tests precede behavior changes. Deterministic schedules cover admission versus cancellation, terminal versus parent input, stale ownership, publication failure, Stop/Start and archive. Native contracts pin actual task, receipt and cleanup boundaries; process/Docker browser E2E verifies broker wiring, child-only activity, reconnect, abort and retained root outcomes. Resource owners use explicit gates, not sleeps or larger timeouts. Replay every DST trace before fixing it. Current qualification belongs in `docs/testing.md`; SDK experimental/release receipts are in `docs/references/pi-sdk-qualification.md`.
