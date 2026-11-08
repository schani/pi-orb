# TODO

The only backlog: one line per item, linked to the owning doc or postmortem. Delete an item when it is done; undecided questions live in `docs/open-questions.md`.

## Bugs

- **Cloud Run service gaps:** open a Google support case with the instance IDs and decide what one-instance operation can tolerate (`docs/postmortems/2026-11-06-control-plane-blackouts.md`).
- **Claude query-rotation incidents:** reproduce the initial-close/late-edge ordering before changing quiescence logic (`docs/postmortems/2026-10-13-claude-query-rotation.md`, `docs/postmortems/2026-11-04-claude-query-rotation-1f315657.md`, `docs/postmortems/2026-11-05-claude-query-rotation-93add73b.md`).
- **Agent-lease database contention:** add real-PostgreSQL pool/lock-contention coverage and bounded pool-acquisition/SQL/transaction timings with backend/operation correlation; identify the original lock chain (`docs/postmortems/2026-10-23-agent-lease-loss-drain.md`).
- **Central Pi alert request-ID conflict returns 503:** `POST /api/runtime/alert` maps the Durable conflict to retryable `unavailable`, while native Claude's `/v1/alert` answers 409 (`apps/control-plane/src/http/runtime-routes.ts`, `docs/orb-alerts.md`).
- **Chromium usage-page viewport overflow:** root-width assertion at `e2e/usage-frontend.e2e.test.ts:442` failed in [CI](https://github.com/schani/pi-orb/actions/runs/39530906083/job/118996304627); cause unknown.
- **WebKit harness-icons navigation readiness:** [first failure](https://github.com/schani/pi-orb/actions/runs/38865297828/job/116856612635) unexplained; its browser diagnostics were not uploaded.
- **Lifecycle E2E failures:** the profile-login challenge timeout and upload-continuation stall (`docs/testing.md`, "Approved exceptions"); distinguish HTTP/provisioning/challenge outcomes and inspect the upload target's tool completion, replication and model ledger.
- **Hosted MCP summary sent no model request:** distinguish summary admission, authentication and pre-acceptance transport failure (`docs/postmortems/2026-10-08-mcp-summary-missing-request.md`).
- **Lifecycle-smoke HTTP 500 from a deleted revision:** explain why the restart GET was served by a deleted revision (`docs/postmortems/2026-10-16-lifecycle-smoke-http500.md`).
- **GlideOS delivery failure:** identify the revision behind the failed resource acquisition; retain sanitized status/content-type/response-shape evidence for checkout failures (`docs/postmortems/2026-10-09-glideos-delivery-blocked.md`).
- **`logging-discard-recovery-after-restart` DST schedule:** about one schedule in 20 answers `retryable` where the scenario expects `progressed`; replay the trace and decide whether the scenario or the restart path is wrong (`apps/control-plane/src/domain/lifecycle.dst.test.ts`).
- **CPU-starvation-sensitive tests:** under CPU contention `adapters/pg/mcp.test.ts`, `adapters/pg/project-instructions.test.ts` and `http/mcp-oauth-routes.test.ts` exceed the 10 s PGlite `beforeEach`, and WebKit tail/wheel tests in `e2e/frontend-mobile.e2e.test.ts` lose their locator; replace wall-clock waits with explicit synchronization (`docs/testing.md`).
- **Transcript target UUIDs:** reject a malformed target with a typed client error before store lookup instead of PostgreSQL `22P02` → 500 (`docs/postmortems/2026-10-13-rollout-monitor-anomalies.md`).
- **Non-UUID orb ID answers 500:** `CreateOrbRequestSchema` accepts any DNS-safe slug but `orbs.id` is `uuid`; tighten the schema or map to 400 (`packages/protocol/src/control-plane-api.ts`).
- **Orb-name trigger folds a store outage into 401:** return 503 so naming retries (`apps/control-plane/src/http/runtime-routes.ts`).
- **Raw database errors reach API clients:** `sendStoreError`/`sendCommandError` echo driver text; return a stable message per class and log the raw text with a correlation ID (`apps/control-plane/src/http/routes.ts`).
- **Upload response-shape mismatch:** capture the endpoint, method and sanitized response shape behind the intermittent `unexpected response shape` before fixing (`docs/workspace-uploads.md`).
- **Control-plane shutdown with a pending device login** outlived the shutdown wait; reproduce with controlled scheduling and bound the drain (`docs/postmortems/2026-09-09-live-web-rebuild.md`).
- **Delivered-message history gaps:** enforce ordered, parent-closed browser history before advancing the resumable cursor; repair a missing ancestor even with the socket open, or show a synchronization failure (`docs/history.md`, `docs/postmortems/2026-09-17-delivered-message-order.md`).
- **Claude unsupported asks:** visibly decline `AskUserQuestion`/`canUseTool` asks, persist a diagnostic and tell the model to ask in chat; never hang (`docs/claude.md`).

## Hardening

- **Inbox Unicode:** `orb_messages` content is JSONB and can reject NUL or unpaired surrogates; store losslessly or reject visibly (`docs/inbox.md`).
- **Parked history polls:** show the user parked replication and blocked inbox delivery without claiming delivery before receipt commit (`docs/postmortems/2026-10-13-claude-history-nul.md`).
- **Claude alert journal writes:** fail closed when a platform-record commit fails after the write (`apps/orb-runtime/src/claude/agent.ts`).
- **Claude alert metadata:** derive read metadata from the platform alert envelope (`content`, `overflow.requestId/message`) so notification flagging works, without new persisted fields (`apps/orb-runtime/src/claude/history.ts`).
- **Claude session continuity:** never silently start a fresh native session when the replica already holds history; offer an operator replication reset (`docs/history.md`, `docs/postmortems/2026-08-03-cursor-not-found.md`).
- **Claude interruption recovery coverage:** cover out-of-band host stop, unreachable-runtime replacement, Stop/Start and settled tails through native ownership/receipt fences (`docs/lifecycle.md`, `docs/claude.md`).
- **Stale control-plane revisions:** fence per-mutation lifecycle authority (start, boot detection, terminal transitions) for out-of-band deployments and late side effects; extend mixed-generation DST (`docs/deployment.md`, `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`).
- **Egress partition before unreachable restart:** corroborate a suspected control-plane egress partition across orbs with bounded fleet evidence (`docs/lifecycle.md`, `docs/postmortems/2026-08-05-egress-blip-false-unreachable-restart.md`).
- **False idle during release handoff:** distinguish unobserved activity from confirmed idle in central metadata and unloaded snapshots; needs approval, deterministic handoff coverage and content-free diagnostics first (`docs/postmortems/2026-10-18-false-idle-during-release.md`).
- **Guest-reported boot failures:** act on a `failed` `pi-orb/boot-status` while `starting`; name runtime dependency failures from the failed job, not `runtime_success` (`infra/native-vm/boot_diagnostic.py`, `docs/postmortems/2026-10-10-bootstrap-metadata-network-race.md`).
- **Boot diagnostics per attempt:** stamp a boot-attempt identity on guest evidence so diagnosis rejects a previous boot's status (`docs/host-provider.md`, `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`).
- **Boot-context retry diagnostics:** persist sanitized attempt/timing class, transport error code and recovery/exhaustion outcome (`docs/postmortems/2026-09-18-boot-context-cold-start.md`, `docs/postmortems/2026-09-30-preemption-boot-context.md`).
- **Late resume-hook verdict:** relay a backgrounded `.agents/resume` failure for a `running` orb to the orb page and the `resume-failed` edge (`docs/orb-setup-hook.md`).
- **Boot-hook output capture:** honor `logFile.write` backpressure and rate-limit the console mirror (`apps/orb-runtime/src/hooks/spawner.ts`).
- **Runtime fetch deadlines:** give every `apps/orb-runtime` control-plane `fetch` a deadline, as the broker and id-token endpoints have.
- **Signing-key `fromStore`:** document or narrow its blanket `retryable: true` for `corruption`/`invariant` (`apps/control-plane/src/domain/signing-keys.ts`).
- **Retired signing keys:** sweep retired keys past the JWKS overlap window, destroying the secret version before deleting the row; DST including a crash between steps (`docs/workload-identity.md`).
- **Broker refresh failures:** log provider, generation and error class on failed refresh and deadline exhaustion, include the last reason in `credential_unavailable`, and reconcile `credential_pointers` against secret versions at boot (`docs/postmortems/2026-09-04-stale-codex-credential-pointer.md`).
- **Docker volume ownership:** after `docker volume create`, verify exact orb-ID and inventory scope before mounting (`docs/host-provider.md`, `docs/postmortems/2026-10-05-e2e-docker-inventory-isolation.md`).
- **Central Durable memory:** attribute shared-process memory by task kind, bound code-mode invocation/fan-out/recovery under the service memory limit, and persist a user-visible confirmed-OOM diagnosis (`docs/pi.md`, `docs/postmortems/2026-10-09-central-durable-oom-recovery.md`).
- **Frontend failure handling:** cover every API read/mutation/poll and both WebSockets: unknown-outcome timeouts, ambiguous mutations, pending actions that always settle, request deadlines, a route error boundary, and auth expiry during send with exactly-once recovery (`docs/web-ui.md`).
- **Frontend preview reloads:** replace the whole process on fixture-backend/protocol changes and make reload failure visible (`docs/web-ui.md`, `docs/postmortems/2026-09-09-stale-frontend-preview.md`).
- **PostgreSQL E2E startup diagnostics:** keep `waitForPostgres` exec errors and container logs before owned cleanup (`docs/postmortems/2026-10-02-docker-daemon-umask.md`).
- **Ignored DST task results:** audit scenarios that await `sim.runTasks` without asserting its `Result` (`docs/testing.md`).
- **Deterministic GCE model:** add injectable preemption and fault controls beyond discard/fence (`docs/lifecycle.md`).
- **Hosted-provider diagnostics:** capture token-safe HTTP/transport outcomes and fix the manual MCP helper's uncaught rejection before reusing its completion oracle (`docs/testing.md`).
- **Identity-smoke cleanup diagnostics:** report token-safe phase/exit/HTTP evidence instead of premature success and silent DELETE failure (`docs/postmortems/2026-10-14-identity-smoke-cleanup.md`).

## Follow-ups

- **Verify dark mode on the installed iPad app** (2026-11-08; `docs/web-ui.md`). Browser checks cover the live scheme switch. On the user's iPadOS 26 home-screen install, confirm the status-bar band turns black and the browser chrome follows the desktop setting.

- **`orb_transcript` pagination** and byte-bounded browser/CLI history paging (`docs/history.md`; postmortems `2026-09-27-history-response-size.md`, `2026-10-02-initial-history-latency.md`).
- **Transcript loading timings:** measure first paint/live-ready and cold/cached switches with extensions disabled; add content-free database-read, parse, projection and serialization timings (`docs/history.md`, `docs/postmortems/2026-10-03-cached-orb-navigation.md`).
- **Standalone re-login action** to repair a mid-run credential revocation without Stop/Start (`docs/credentials.md`).
- **Charts for Claude orbs**, e.g. a pi-orb MCP tool whose result carries the chart spec outside model-visible content (`docs/web-ui.md`).
- **Expose deployment holds on OrbPage** through the existing deployment status, not a new API (`docs/web-ui.md`).
- **Remove multi-call `ToolActivity` aggregation** (`CallRow`/`OwnedCallRow`, distinct-path counting), unreachable now that each tool call renders alone (`apps/web/src/components/ToolActivity.tsx`).
- **Remove unreachable non-Linux process-host paths** (unsupervised spawn, `liveProcessRows`, non-Linux termination ladder) (`apps/control-plane/src/adapters/process/provider.ts`).
- **Remove the unused live `message` client action** from `ClientActionSchema` and the runtime server; browsers send messages through the inbox (`packages/protocol/src/frames.ts`, `docs/runtime-protocol.md`).
- **Remove the `central_agent_paused` special case** the control plane no longer emits (`apps/web/src/pages/OrbPage.tsx`).
- **Align the boot-hooks skill with code** (prompt change, needs approval): context-delivery claims (`apps/orb-runtime/skills/boot-hooks/SKILL.md`); remove `bootHookPrompt`, which has no production caller.
- **Soft-wrapped terminal copy:** fix upstream in wterm by exposing wrapped-continuation metadata, then upgrade (`docs/terminal.md`).
- **Maintenance restoration watchdog:** before any deliberate UI pause, arm a watchdog independent of agent and UI that restores scaling, files routing and access (`docs/deployment.md`).
- **Database credential rotation** (deferred by the user): recovery authority as a separate Actions job inside the release lock (`docs/deployment.md`, `docs/postmortems/2026-09-09-tracked-deployment-credentials.md`).
- **Tailscale owner cleanup:** the owner may delete retired devices, join keys and the upstream OAuth client in Tailscale admin (`docs/http-exposure.md`).

## Live verification

- **Compute replacement smoke** on disposable live GCE (`infra/smoke-compute-replacement.sh`, `docs/lifecycle.md`).
- **Destructive orb deletion** on live GCE: instance and data-disk removal, idempotent repeat, exact ownership (`docs/teardown.md`).
- **Native security baseline** through actual VM reboot, stop/start and full-image replacement with retained workspace/Docker/containerd stores, including missing-disk refusal (`docs/host-provider.md`).
- **Central Durable** under host loss and database failover (`docs/pi.md`, `docs/lifecycle.md`).
- **Migration job** against a disposable fresh database (`docs/deployment.md`, `docs/postmortems/2026-08-26-workload-identity-cloud-release-gates.md`).
- **Workload identity:** run `infra/bootstrap-pi-orb-oidc.sh` with a real project grant, then the identity smoke with `PI_ORB_SMOKE_WIF_*` so STS exchange, impersonated read and wrong-audience rejection execute (`docs/workload-identity.md`).
- **Identity E2E parity:** `pi-orb id-token` legs run only through `docker exec`; cover the process backend too (`docs/workload-identity.md`).
- **Previews and access tokens:** 12-hour re-login; Chromium and Safari; `agent-browser` with `__Host-pi-orb-token` reaches a same-owner preview (document, SSE, WebSocket) and hosted file, cross-owner gets 403, an open preview survives target stop/start, and no token appears in request logs (`docs/http-exposure.md`).
- **Files origin:** production request-log exclusion including edge/custom/ancestor sinks; cloud-development outer-preview/inner-local admission, cancellation and telemetry (`docs/http-exposure.md`).
- **Hosted files on GCS:** opt-in contract against an isolated bucket; streaming, backpressure, cancellation and memory through Cloud Run; archive retention and deletion against real objects (`docs/http-exposure.md`).
- **Workspace uploads through Cloud Run:** memory with a large file and slow consumer, interruption/retry, Stop, retention across native compute replacement (`docs/workspace-uploads.md`).
- **Project secrets on GCE:** setup lacks them while resume/agent/terminal receive them; rotation across stop/start; no leakage; project delete removes every version and pointer (`docs/credentials.md`).
- **Rollout isolation:** live-check the startup activation barrier and retirement inventory against actual old processes (`docs/deployment.md`, `docs/postmortems/2026-09-09-deleted-browser-reconciler.md`).
- **Rollout-monitor 429 recovery:** live trace propagation and same-invocation recovery for mint-floor and ingress 429s (`docs/deployment.md`).
- **Code-mode CPU headroom:** sustained multi-worker load on the two-vCPU revision; confirm serving headroom and ingress admission (`docs/pi.md`, `docs/postmortems/2026-10-09-control-plane-cpu-429.md`).
- **Central code-mode memory metric:** create the live-worker log-based metric from `codemode.memory` samples (`docs/pi.md`).
- **MCP providers:** Cloudflare and Datadog US5 natural session expiry, isolated downstream grant revocation, Datadog's organization redirect allowlist for the callback, and site/IP pinning; fake HTTPS or public metadata never qualifies (`docs/mcp.md`, `docs/postmortems/2026-09-30-native-mcp-qualification.md`).
- **Google login:** signed-out login in Chrome and Safari through our callback; same-tab expired-session return preserves path and draft (`docs/auth.md`, `docs/postmortems/2026-10-23-google-signed-out-login-500.md`).
- **Phones:** physical iOS/Android momentum scrolling, repeated keyboard open/close, dismissal/blur/rotation, safe areas, long drafts, fold-to-abort; missing-orb view beside the rail on iPad/Firefox (`docs/web-ui.md`).
- **iPad home-screen app:** status-bar band invisible with menus open; hardware-keyboard composer keeps the header; transcript, hosted-file, Claude consent and MCP Connect links open Safari and complete their flows (`docs/web-ui.md`, `docs/mcp.md`).
