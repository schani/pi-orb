# Subagent E2E post-tool stalls — 2026-10-08

Status: recorded hosted provider waits remain unattributed; the user waived their explanation as a merge/deployment requirement on 2026-10-08. The separately reproduced broker cancellation fault is repaired and undeployed.

## Conclusion — user decision, 2026-10-08

The recorded HTTP POSTs to fake-openai `/codex/responses` remained pending until the 60-second test deadline. Evidence does not establish server receipt or the cause of the root-continuation/child-first-inference waits. The user accepted these historical stalls and the separate truncated APT download as not requiring further explanation. Neither network causality nor elimination of stalls is claimed. Earlier investigation requirements below describe the pre-waiver decisions; they are no longer release blockers.

The agent-owned Unix-socket checkpoint experiment is abandoned under this decision; retain `.context/pr66-checkpoint-*` red/green evidence. Committed bounded audit instrumentation remains. First-attempt CI 37816944042 and all four normal E2E shards 37816943899 passed source `5a059ad796b5f3ed9b1c780250f322ea45931f77`; exact-main qualification and correction of new failures remain mandatory (`docs/testing.md`).

## Evidence

Normal E2E [37734950460, attempt 1, shard 2](https://github.com/schani/pi-orb/actions/runs/37734950460/job/113172262915), source `db261fae2fe134cf0d657c4d728ad2247b3f65b0`, failed both tests in `e2e/subagents.e2e.test.ts`:

- **Delegated work through abort/recovery/archive:** line 317 waited 60 seconds for `PARENT_SETTLED_2`. Root ledger admitted and started child 2, then persisted both tool results at 01:08:19.681 America/Cancun. No subsequent root assistant entry appeared. The model ledger ends at rules 9 (root delegation) and 10 (child); no following model request was recorded. Runtime health remained ready/busy with the operation ID. Capture's phase was still `abort`: failure preceded the assignment to `recovery`, not proof that abort itself failed.
- **Unknown profiles/models and explicit Sol dispatch:** line 658 timed out waiting for `PROFILE_SETTLED_0`. Root ledger persisted the subagent tool result at 01:09:44.959 America/Cancun. Model evidence contains only the initial rule-0 request, not a continuation. Runtime health remained ready/busy.

Preserved originals: `.context/pr66-webkit-cohort-diagnostic/37734950460-job-113172262915.log` and `.context/pr66-webkit-cohort-diagnostic/normal-e2e-artifacts/e2e-dst-failure-traces-2-37734950460-1/subagent-{lifecycle,profiles}/failure.json`.

An unchanged, pointed process-backend baseline completed both tests locally (197.214 seconds and 67.766 seconds; total 267.27 seconds). Log: `.context/pr66-subagent-diagnostic/baseline.log`. It neither reproduces nor clears the hosted failures. Completed tests were not rerun.

## Limits

The original bundles retained root entry identities, tool-result presence, runtime activity and mock event counts, but discarded active stream state and persisted `pi-orb.stream-audit` metadata. Runtime logs and raw native/provider contents were not uploaded. Test cleanup deleted the mock sessions. The available evidence cannot distinguish SDK boundary work, broker admission, pre-acceptance transport failure, or another stalled continuation.

Naming uses an independent mock session. Neither failing continuation shows a competing request advancing the inference cursor. The MCP summary-cursor finding therefore does not establish these failures' cause. No lifecycle DST failure trace is implicated by these two E2E failures; unrelated historical traces in the artifact are not reproductions of them.

## Evidence decision — 2026-10-08

Extend only the test failure adapter: retain bounded, explicitly whitelisted active-stream and persisted-audit IDs, numeric timings/counts/status, event categories, phases, transport and issue/terminal categories. Exclude prompts, tokens, payloads, free-form errors and runtime/auth logs. Keep the existing 64 KiB/30-entry local tail and at most 30 active stream rows; missing older audits remain a diagnostic limit. Existing `test-failures/subagent-*/failure.json` artifact retention covers the addition.

Diagnostic stages are not a corrective lifecycle change or release qualification. Do not infer historical repair from a passing local probe, broaden retries, weaken assertions or increase timeouts. The user waived explanation of the separate historical WebKit failures as a merge/deployment requirement on 2026-10-08 (`docs/postmortems/2026-10-08-webkit-reload-internal-error.md`); these non-UI failures remained blockers at that point. The later provider/APT decision above waives their historical explanation.


## Broker fault and repair — 2026-10-08 (local)

The pinned SDK refreshes with five minutes remaining, supplies a cooperative 15-second cancellation signal and holds its credential-file lock across the refresh callback. Our provider discarded that signal. Broker HTTP headers and successful JSON-body consumption had no deadline; the client checked its retry window only after endpoint settlement, and `Retry-After` could exceed it. Native abort could therefore settle the outer run while broker I/O and credential ownership remained active.

A real-SDK fixture executes and persists a tool result, then deliberately moves the credential into the four-minute refresh window. Holding either broker headers or its successful body leaves one inference request, a busy session, an unmatched `auth_resolution` entry and the auth lock. Reintroducing the original dropped signal reproduces the failure in both phases: `.context/native-post-tool-broker-original-signal-red.log`. Corrected forwarding drains I/O and permits subsequent auth with the lock released (`apps/orb-runtime/src/broker/post-tool-refresh.contract.test.ts`). This fixture proves the fault class, not the original stalls' cause.

Provider login/refresh signals now reach the broker client. Existing 60-second startup/30-second refresh budgets cover I/O and backoff; HTTP also owns a 30-second request budget through body consumption. Status-only responses cancel and drain their bodies. Coalesced waiters cancel independently; the last owner aborts and drains shared I/O before credential-lock release, and replacement callers start only after that abandoned flight drains. Monotonic fences prevent late/cancelled grants even with delayed timer callbacks. Retry hints cannot extend the flight budget. No continuation watchdog, replay or retry policy was added. Contracts and DST cover these rules (`docs/credentials.md`).

Content-free durable native stage edges now cover turn-end, next-turn preparation, projection, context hooks, stream allocation, auth, header hooks and SSE fetch admission (`docs/pi-adapter.md`). Stream allocation returns immediately while auth can remain pending; pair operation/session/stage/sequence edges rather than treating its exit as completed auth. Sequence counters reset on boot within the same native session. The bounded failure whitelist retains these edges without prompts, credentials, payloads or free-form errors. SSE fetch instrumentation does not observe WebSocket setup, and auth-stage evidence does not isolate credential reload from lock acquisition.

The matching fixture/default fake grants use 3,600-second TTLs, as does a later local ledger; the original hosted captures retained neither actual TTL nor expiry. The profiles case failed before child inference, earlier than expected refresh under that default, not proof of a fresh credential. Clock/expiry state, credential mutation and forced-refresh causality remain unknown. Neither normal expiry-driven refresh nor the reproduced broker fault is established as either hosted stall's cause. Original bundles cannot retrospectively identify the awaited stage. Fresh hosted diagnostics must capture the new stages on an actual matching failure; local passes and this auth repair do not clear that requirement.

## Qualification evidence — 2026-10-08

The first full suite (`.context/post-tool-npm-test.log`, 12:58–13:13 UTC / 07:58–08:13 America/Cancun) overlapped source edits and reported five failures. Preserve it and the traces; it is not frozen-source qualification:

- HTTP late-grant fence and client late-grant DST exposed missing monotonic checks. The client repair at 13:01 UTC and HTTP repair preceding the final adapter checks occurred during that suite; its HTTP report still lists six tests, before the seventh status-drain test. Explicit pre-fix client replay: `.context/broker-late-grant-replay-red.log`; identical first trace passed after correction in `.context/broker-late-grant-replay-fixed.log`. The suite's additional trace remains `test-failures/broker-late-response-grant-fence-1791464800419-0.json`.
- GitHub grant and auth-required DST fixtures assumed short latency timers always precede the budget. Their traces fire the 10-second deadline before the approximately 10–15 ms latency timer; unavailable is correct under that schedule. Both were explicitly replayed before correction (`.context/gh-{grant,auth}-budget-replay-red.log`). Success-only fixtures now select earliest timers; adversarial budget tests retain unrestricted schedules. Corrections postdate suite completion.
- Sleep-boot's mocked session lacked the public Agent interface required by instrumentation. `.context/boot-agent-stage-fixture-replay-red.log` replays the missing `finishTurn` receiver; the fixture now supplies a real Agent without changing production behavior. Correction postdates suite completion.

The two corrected fixture files passed all ten tests in `.context/post-tool-fixture-corrections.log`. Earlier evidence includes 59 focused passes, nine final HTTP/native contract passes, typecheck/lint passes, both pointed subagent E2Es and a later final-source profiles pass. None attributes the historical hosted stalls. Subsequent frozen-source qualification and the diagnostic's evidence limits are recorded below.

## Hosted first-attempt qualification — 2026-10-08

Exact head `c89ad822ce00d0371c4bcf6a2605d82d278d5246` passed first-attempt [CI 37787839513](https://github.com/schani/pi-orb/actions/runs/37787839513) and all four normal [E2E shards 37787839505](https://github.com/schani/pi-orb/actions/runs/37787839505). Manual [diagnostic 37787839032](https://github.com/schani/pi-orb/actions/runs/37787839032) passed six independent subagent-only Vitest invocations, two tests each. Evidence: `.context/pr66-staged-hosted/outcome.md` and `diagnostic-completed.log`. These are first-attempt results, not reruns. The 12 pointed passes do not attribute or clear either historical non-UI stall.

## Original-cohort hypothesis — 2026-10-08

Those six invocations omitted the preceding original shard-2 files. Environment, resource or state interference from that cohort remains untested. The next authorized diagnostic uses four isolated runners, each executing the entire original shard 2 once, including its preceding test mix, within the unchanged 40-minute job budget. This tests a different exposure, rather than blindly repeating the pointed probe; it is not full four-shard qualification or a causal repair.

Stop at evidence of the first matching staged fault class and identify the actual awaited method; pass counts cannot clear the stalls. Preserve every failure log/artifact and first-attempt source/event/ref/job metadata. Parent decides further work after capture. No assertion weakening, timeout change, retries, speculative runtime fixes, merge or deployment. Normal automatic CI/E2E remain mandatory for the new source; c89's results do not qualify it. Manual-source evidence remains excluded from release qualification. Plan and run IDs: `.context/pr66-original-cohort/{plan.md,runs.json}`. Original TTL/expiry remain unknown; 3,600 seconds is only the fresh-fixture default.

## Fresh original-cohort failures — 2026-10-08

Head `f0af97f96999fa50593cc013c1835816f287ec9e`, unchanged runtime/codec from c89, produced new failures. Normal [E2E 37793691292 shard 2](https://github.com/schani/pi-orb/actions/runs/37793691292/job/113367459627) fails `PROFILE_SETTLED_1`; diagnostic [37793709660 runner 4](https://github.com/schani/pi-orb/actions/runs/37793709660/job/113367531465) fails recovery and profiles after admitting child 2. Runner 3 passes the same cohort. Originals: `.context/pr66-original-cohort/evidence/`; diagnosis: `.context/pr66-provider-stall-diagnosis/`.

Auth/header completes. Normal profiles has unmatched root `provider_http` ENTER sequence 25; recovery has unmatched ENTER sequence 5; diagnostic profiles has child header EXIT and a waiting child stream, without child HTTP instrumentation. These captures do not match the reproduced auth-lock stall.

Normal accepted model rules are 0, 2, unmatched HTTP400, 3. Diagnostic profiles accepts 0, 2, 3, 5, unmatched HTTP400, 6. Thus case 0 settled in both captures, and diagnostic case 1 settled too. The HTTP400 does not itself prove cursor theft: a subsequent root rule was accepted. Model ledgers count accepted requests, not all HTTP attempts. They cannot locate the pending fetch inside the remote provider or establish that it never attempted HTTP.

Pinned [fake source eaa274c](https://github.com/glideapps/fake-openai/tree/eaa274c562ea7b1ec6dce496a1442cfbb55b4106) distinguishes `invalid_body` from `no_matching_rule`. Retained evidence discarded that distinction and request model; sessions were deleted during teardown. Luna summaries share runtime inference, despite the independent naming session. A summary mismatch is plausible, not proven. The SDK's SSE path compresses the full body; `previous_response_id` delta continuation is WebSocket-only, so that cache hypothesis is unsupported here.

Tests-first diagnostics retain allowlisted model class, encoding, input count and mock error category, never raw bodies, headers, prompts or error messages. This repairs an evidence gap, not the provider stall. No causal repair or clearance is claimed.

## Owned inference wire boundary — 2026-10-08

The f236b38 experiment routed both process-backed subagent fixtures through a test-owned loopback proxy. Auth/header completion and root `provider_http` entry establish SDK progress, not hosted acceptance; older bundles contain no wire-arrival evidence. The proxy forwards Root, child and Luna requests once to the unchanged fake `/codex/responses` endpoint, preserving OAuth/naming contracts and script/assertion semantics. No retry, deadline, continuation watchdog or production/runtime protocol change is introduced.

The bounded 64-row ledger distinguishes incoming body completion, upstream entry, upstream headers, first response byte and typed terminal outcome. Public allowlists cover model/fixture marker, integer input/byte counts, encoding, method/path class and mock HTTP400 category. Payloads, bearer credentials, raw URLs/headers and free-form errors are excluded. Capture freezes the ledger before probes and teardown; control-plane stop precedes owned proxy-flight cleanup. The experiment could distinguish missing incoming traffic, missing upstream headers and blocked response body, but moved DNS, TLS and pool ownership from runtime to Vitest; it did not preserve the original native transport.

The real-HTTP hop-header contract failed before correction and passes after request/response filtering; original RED evidence remains `wire-integration-red.log`. Frozen source passes 21 focused unit/integration/evidence tests, E2E typecheck and scoped lint (one existing informational finding). Quick review found no additional defect. Evidence: `.context/pr66-provider-stall-diagnosis/{wire-ready.md,wire-targeted-final.log,wire-typecheck-final.log,wire-lint-final-check.log}`. Full first-attempt automatic CI/all four E2E shards and the separately named original-cohort diagnostic remain pending; no local full suite was repeated. Historical fixtures and assertions are unchanged; neither this instrumentation nor c89's different broker fault repair attributes the original stalls.

## Direct native observation — 2026-10-08

Parent approved the test-only proposal in `.context/pr66-direct-transport/plan.md`. All four executed f236b38 proxy cohorts passed; prior f0af direct HTTPS runs stalled in two of five cohorts (Root CASE1 settlement / child2 dispatch), with auth and headers complete but provider_http pending. This contrast is experimental evidence, not a causal repair. Root stall cause remains unresolved.

Both fixtures restore the original fake HTTPS inference URL. A private test-owned preload subscribes to bundled Node 24.6 / Undici 7.13 diagnostics without replacing fetch/global dispatcher or changing SDK retries, deadlines or pools. Guarded runtime entrypoint/orb identity excludes CP and inheriting Node tools. Exact origin/path checks occur transiently. Startup versions and configured positive UV_THREADPOOL_SIZE (otherwise null) are recorded, never changed. Each restart owns an orb/pid file.

The 64-event tail reports dropped events; bounded active summaries report their own evictions. Only sendHeaders joins request and socket; overlapping connection attempts cannot be correlated by timestamps. Connection edges concern the fake host, not necessarily inference. Root/child/Luna remain unknown: caller phase/case timestamps are temporal brackets, not request ownership. No bodies, headers, URLs, tokens, sockets, raw errors or Node arguments are persisted. Error categories are allowlisted. Callback/I/O exceptions are contained; missing, invalid and unavailable audits are explicit. Atomic synchronous snapshots add scheduling/I/O cost, not transport redirection.

Failure capture reads local audits before remote probes and cleanup; successful cases save bounded local snapshots too. Approved green-job retention uploads only sanitized `test-failures/subagent-*/success.json` projections with an always-run, shard/run/attempt-qualified artifact (14 days); private runtime snapshots and auth logs remain excluded. The same source includes separately reviewed APT acquisition verification and UI readiness-gate corrections; these do not repair or attribute provider stalls (`docs/postmortems/2026-10-08-runtime-apt-size-mismatch.md`, `docs/web-ui.md`). Fresh immutable direct-transport qualification and an actual reproduced stall are still needed; no historical cause or release clearance is claimed.
