# Pi system state entered replicated history

**Incident date:** 2026-09-23
**First failure:** GitHub Actions [run 35915854058](https://github.com/schani/pi-orb/actions/runs/35915854058), `e2e/full-slice.e2e.test.ts:1861`
**Evidence:** `.context/release-5c7b1b4/e2e-failed.log`
**Release:** `5c7b1b40fce1e0b1388b421503db97bea3b2c36f`, blocked before deployment

## Impact

The release E2E found personal-instruction text in replicated native history. The same record contained Pi's complete initial prompt sections and tool declarations. It was hidden by the UI but present in runtime history responses, live history frames, the control-plane replica, browser memory, and lossless transcript JSON. The failed assertion also printed a truncated copy into the private run log.

No production rollout passed this gate. Pi's authoritative local JSONL and model requests necessarily retain the system state; the defect was copying that execution configuration into product history.

## Cause

Pi 0.86 introduced transcript-backed system prompt and tool state. Upgrading from 0.85.1 to 0.87.1 made the first request persist a `message` entry with role `system`; later changes use more system messages, and compactions can carry a complete `systemMessage` checkpoint.

The Pi adapter already mapped an unknown message role to a hidden event, but its common identity builder copied every complete native entry into `overflow.native`. The normalized event therefore hid only presentation, not data. Compaction checkpoints had the same latent exposure.

## Correction

The adapter now treats Pi system state as local execution configuration:

- native system-message records keep their ID, parent, timestamp, append position, and hidden event type;
- replicated native overflow keeps only the system-message role and message timestamp;
- compactions retain their ordinary summary and native metadata but reduce `systemMessage` to the same identity projection;
- every other native conversation entry remains lossless.

This boundary serves both replication snapshots and live publication. Pi's local JSONL is not modified, so resume, compaction, model context, cursor identity, and ancestry are unchanged.

## Tests and standing rule

Mapping regressions cover system records and compaction checkpoints. A real Pi 0.87.1 SDK contract proves the full prompt and a custom tool declaration remain in local JSONL while mapped records preserve every ID and parent without those values. Live publication has the same assertion. The existing full-slice confidentiality assertion remains unchanged.

**Rule:** harness execution configuration may remain in the harness's authoritative local state but must be reduced to an identity-only record before entering live or replicated product history. Never omit or reparent the native record to achieve confidentiality.

## Qualification finding

A 2026-09-23 process-backend full-slice run passed the original replicated-history confidentiality assertion, then failed deterministically at `e2e/full-slice.e2e.test.ts:1887`. The retained request matched fake-inference rule 3, returned 200, used `gpt-6-sol` with low reasoning, and included the restart warning. It contained only FIRST-boot personal/project instructions: no later system delta selected the NEXT-boot snapshot. The request's effective prompt was stale.

Pi 0.87.1 rebuilds `AgentSession.systemPrompt` from the current resource loader, but an idle `sendCustomMessage(..., { triggerTurn: true })` enters `_runAgentPrompt()` without the prompt/tool reconciliation performed by `prompt()`. Orb restart and resume notices use that custom-message path, so a restarted session can send its prior transcript-backed prompt despite loading new instructions.

Upstream [issue #5581](https://github.com/earendil-works/pi/issues/5581) confirms the intended boundary: custom messages bypass user-input processing, not agent-run preparation. On 2026-09-23 pi-orb pinned Pi 0.87.1 and added a version-specific `patch-package` patch. Normal prompts and idle or deferred custom-triggered turns share model/auth/compaction, `before_agent_start`, current prompt and active-tool preparation. Streaming steer/follow-up messages stay inside their existing prepared run. The custom restart record retains its native role, content, visibility and details; hook injections are custom records and no synthetic user record is created.

The narrower `context_with_system` workaround was rejected. It repaired only the provider payload, skipped `before_agent_start`, did not persist the prompt delta or reconcile tools, and risked unnecessary prompt-cache invalidation. A real SDK restart contract instead reopens a persisted old-prompt/tool session and proves that an idle custom trigger sends the current prompt and tool definition, runs the hook once without the input hook, preserves both custom records and metadata, and adds no user entry.

The patch is reproducible in every production install path: root `npm ci` applies it from `postinstall`; Docker and native-image installs retain `--ignore-scripts` and invoke `npx --no-install patch-package` explicitly. Pi and `patch-package` are exact pins, and patch mismatch fails installation. The isolated subagent characterization remains an intentionally unmodified SDK install; its runtime mode imports the patched root SDK.

## Fix qualification

A clean `npm ci` applied the patch successfully. The first full suite then failed 11 of 17 subagent schedules: awaiting preparation before marking a custom run active exposed an idle edge and made preparation uncancellable. The patch now claims run activity synchronously, lets abort suppress inference after a pending hook, and preserves the original continuous busy span; the cancellation contract and all 17 schedules pass.

The first focused process E2E after adding shared preparation contained NEXT markers in a framed developer delta while retaining FIRST markers in leading `instructions`. That is Pi's intentional representation for models supporting mid-conversation system updates: replaying the delta makes NEXT effective. Treating the leading field alone as authoritative was a test bug. The temporary forced-prompt projection made the substring assertion pass but unnecessarily discarded protocol history and cache behavior; it was removed on review. The E2E now folds Pi's framed section updates and asserts the effective active instructions. The replicated-history confidentiality assertion remains unchanged.

Custom preparation owns an abort controller until the core agent run starts. Auth checks receive its signal, cooperative `before_agent_start` hooks see it through `ctx.signal`, and checkpoints prevent later compaction, hooks, or inference after cancellation. `abort()` still waits for non-cooperative third-party hooks; it does not report idle while their promise remains unsettled.

Final checks: 285 unit/DST files passed (2,197 tests; 8 opt-in skips), all infrastructure tests passed, typecheck passed, and lint completed with three pre-existing warnings and one informational diagnostic. Docker CLI is installed but its daemon socket is absent, so the required Docker-backed `npm run test:e2e` could not run; no retry was attempted. No deployment occurred.

Evidence is retained, ignored and mode `0600`, at `.context/release-5c7b1b4/process-e2e-failed.log` and `.context/release-5c7b1b4/process-fake-inference-requests.json`; `.context/release-5c7b1b4/e2e-failed.log` remains the original GitHub release failure. The history sanitization and dependency-patch changes remain local and uncommitted.
