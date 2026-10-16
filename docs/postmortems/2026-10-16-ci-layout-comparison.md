# Controlled CI layout comparison — 2026-10-16

**Result: mandatory success gate failed; faster passing CI remains unproven.**
Root cause is **under investigation**; no product, harness or environment attribution or fix is established.

## Frozen comparison

Both manual diagnostic controllers checked out `f43eff0f84a27eacd48f7aa30d5148e78463778c`.
A used the reference 11-job layout; B used the optimized 19-job layout. Application/tests were unchanged, not older baseline source.
All 30/30 job source records matched the frozen full-tree fingerprint.
Assertions, seeds and skips were preserved; normalized file coverage and per-file expanded case/skip counts match.
A executed frontend coverage twice, B once; raw execution totals therefore differ.
Both trials retained two independent normal control-plane image builds, Durable's offline packaged-worker proof and real-PostgreSQL coverage.

- [A 38953260252](https://github.com/schani/pi-orb/actions/runs/38953260252): **PASS, 11/11**, 20m01s.
- [B 38956005588](https://github.com/schani/pi-orb/actions/runs/38956005588): **FAIL, 18/19 jobs passed**, 11m46s; not a valid speedup.

Wall time is workflow creation → last actual job completion. These manual comparisons are not trusted-main release qualification.

## First failure and limits

B's Docker E2E (1/4), `e2e/full-slice.e2e.test.ts`, failed its first case, `runs login, a scripted tool round trip, replication, and drain`.
At `runScenario:2604`, `expectPage(page.getByText("SPAWNED_TASK_COMPLETE", { exact: true })).toBeVisible()` timed out after 5,000 ms; the final ARIA snapshot showed navigation and “loading projects…”. Three other cases passed.
This new UI failure blocks shipping under `AGENTS.md`; follow-up lives in `TODO.md`.
The failure artifact adds `full-slice-upload/failure.json`; its 19 historical traces are byte-identical. No new DST trace was found.
Both authorized dispatches were consumed; no reruns or fixes were performed.

The permitted Deploy used at most one runner; repository history shows only A/B newly created during the pair. A short observer gap is retained; continuous account-wide isolation is not established.
One sequential pair, mutable hosted hardware/network/cache inputs and no passing B limit the result; deployment benefits remain unmeasured.

Original logs/artifacts and receipts remain in ignored `.context/pr133-controlled-benchmark/trials/`; `trials/REPORT.md` and `audit/REPORT.md` there record coverage, provenance, timings and observation limits.

## Local diagnosis — 2026-10-16

The first diagnostic phase preserved the backend/browser evidence distinction:
backend completion and HTTP 200 do not prove browser receipt, parsing or selection publication.
No browser request ledger, screenshot or DOM was retained for B before teardown;
its exact stalled boundary remains unknown.

Promise-gated built-shell experiments established:

- Holding projects alone still renders the completion marker within the unchanged 5-second expectation.
- Holding metadata with complete history, or history with complete metadata, leaves the cold main empty.
- Holding history after `route.fetch()` buffers the upstream body but before `route.fulfill()` acknowledges it also leaves the main empty.
- Metadata HTTP 200 headers with an unfinished body leave the main empty despite fulfilled history.
- Releasing each gate renders the marker. Unit schedules distinguish an unresolved current load from a cancelled same-orb load and reject acceptance after cancellation.

These are controlled pending-load states, **not a reproduction or clearance of B**.
Installed Playwright 1.63 buffers the complete upstream body before `route.fetch()` resolves;
`response.text()` reads that buffer. Fulfillment acknowledgement is not frontend JSON parsing or publication.

The local Vitest-default build bundles development React: its served asset matches a
`NODE_ENV=test` build containing development-only React diagnostics. Changing only
`NODE_ENV=production` removes the duplicate initial session/metadata/history/projects
requests in the metadata-body experiment. Both schedules publish after release.
B's actual web bundle was not retained; duplication is not its proven cause.
The fixture uses one constant principal; normal same-principal refresh does not remount `PrivateApp`.

Diagnostics now freeze an allowlisted request/interceptor ledger at the original failure,
then capture structural DOM/debug metadata and a masked screenshot **before browser close**.
Request IDs link browser history requests to upstream-buffer/fulfillment stages.
Existing failure JSON includes the ledger and structural snapshot; screenshots remain local
because the current uploader does not include them. No auth headers, cookies, raw model text
or browser profile are captured. The original visibility assertion and timeout are unchanged.

Focused observer/load tests and browser gates pass; no product fix was made.
The original Docker/host-pi scenario was not executed: this workspace's sole Docker context
points to an absent `/var/run/docker.sock`, preventing daemon and runtime-image verification.
No process-backend substitute, benchmark rerun, CI dispatch, push or deployment occurred.
Local logs, captures and hash verification live in
`.context/pr133-controlled-benchmark/failure-rca/diagnosis-20261016T201810Z/`.

## Original-case local execution — 2026-10-16

An isolated, owned Docker daemon removed the default-socket blocker without opening
prior Docker storage. The normal runtime Dockerfile built from unchanged f43 inputs;
the normal E2E global setup built it again. No native image or private-registry image
was reused. Application/runtime source remained unchanged.

One instrumented original Docker/host-Pi first case ran from 1:47:39–1:54:16 PM PDT
and passed, including upload, archive and project deletion. The original 5-second
visibility assertion remained unchanged. Node was 24.6.0, system Chromium
155.0.8059.39, and the actual browser build used `NODE_ENV=test` and
`index-CwNFK0uA.js` (SHA-256
`709e1d8ae8a2f4fe32ab2cabf237814595121b1df15ece6d0f6adfe392031b38`).
Only the browser context was fresh: the VM/browser installation had already run
controlled gates. CI's exact Chromium version was not retained. This is not a
fresh-VM/system-cold reproduction, and browser lifetimes do not prove startup time.

The retained success ledger shows duplicate session/metadata/history/projects reads.
Both intercepted histories contained 22 records and the completion marker; both
browser history bodies finished. The marker was visible 958 ms after `goto`
completed. No page error, crash or disconnect was observed. Thus duplicate reads
are not sufficient to cause B; this successful counterexample does not explain
or clear the historical failure. No retry or product fix followed.

A tests-first regression also fixes diagnostic loss when screenshot capture rejects:
structural DOM remains in the successful capture Result consumed by the existing
uploaded failure JSON, with an independent screenshot outcome. The original
assertion error remains unchanged. Twenty focused observer/load tests, E2E
typechecking and scoped Biome pass.

Original A/B receipts reverify all 784 recorded artifact hashes with no mismatch;
local failure artifacts are unchanged and no new DST trace exists. No CI dispatch,
push, merge or deployment occurred. Evidence:
`.context/pr133-controlled-benchmark/failure-rca/diagnosis-original-20261016T204043Z/`.

## Approved CI diagnostic — 2026-10-16
One approved [CI run](https://github.com/schani/pi-orb/actions/runs/38967852310) passed once on a fresh Ubuntu 24.04 runner, using f43 functional source plus diagnostic payload `3e7195f2e301bb0e413cb7306f557e839c76c7fa`.
The original visibility assertion/timeout were unchanged; duplicate reads completed and the marker appeared 635 ms after `goto` returned.
This is another counterexample, not B's historical cause, a fix or shipping clearance. No further run was authorized. Evidence: `.context/pr133-controlled-benchmark/failure-rca/ci-diagnostic-20261016T210334Z/REPORT.md`.


## Corrective application barrier — 2026-10-16 (reviewed, locally validated)

The test mixed bootstrap readiness with rendering: `goto` does not acknowledge
accepted orb metadata/history. `docs/transcript-cache.md` requires causal barriers,
not a cold-start latency threshold. No later exact-child/head barrier existed to
move; upstream `appliedCursor` and received frames are not React application.

A controlled old-order reproduction withheld metadata while both browser history
bodies completed with the marker. The original visibility expectation failed at
5,000ms. Independent per-request StrictMode schedules (cancelled pair first,
active pair first with old replies last, crossed metadata/history) published
correctly after the current owner's dependencies completed. No product
cancellation race was reproduced. These schedules do not recover B's missing
request history or establish its unique cause.

The selected functional-test contract acknowledges the expected child, session,
cursor, head and record count through the existing `piOrbDebug.dump().current`
projection before checking visibility. That projection is owned by the mounted
conversation after cold metadata/history acceptance, not by a network observer.
The readiness wait is bounded at 30s; the existing 5s visibility assertion and
720s case bound remain. This **changes the bootstrap acceptance window**; it does
not preserve a goto-to-marker 5s deadline or claim a performance improvement.
Settings, cache/no-extra-history, privacy and upload assertions remain.

Tests-first evidence includes the controlled 5s old-order failure, a failing
missing-barrier regression, then successful owned-request schedules and
exact-projection predicate checks. The diagnostic ledger records the new
`history-applied` edge; existing pre-close failure capture remains. Production
code, persisted state and wire contracts are unchanged.

Receipts: `.context/pr133-controlled-benchmark/failure-rca/corrective-20261016T214127Z/`.
Independent review and the original-case local validation are complete below.
Normal exact-head qualification remains pending; B's shipping gate remains.

## Post-fix local validation — 2026-10-16

Independent review accepted the exact application barrier; one authorized original
Docker/host-Pi first case then passed on its first attempt, with no retry
(`loopCounter=0`). The case took 365.301s; Vitest took 390.18s; the provider wrapper
ran 2:58:04–3:04:47 PM PDT (402.879s). Three other cases were filtered as requested.
Normal runtime global setup built from all 421 unchanged runtime inputs; no
prebuilt-image override or production-mode build was used.

The pre-close ledger records duplicate metadata/history reads finishing, both
histories containing 22 records and the marker, then `history-applied` at 1782ms
and marker visibility at 2072ms (observer-relative). The 30s application barrier,
original 5s assertion and 720s case bound were unchanged during validation.
The complete case passed real WebSocket/tool/PTY, child spawn, cached hello with
no extra history read, settings/privacy, upload verification, drain, self-delete,
archive and project deletion assertions—not only marker visibility.

No browser crash, disconnect, page error or new failure artifact occurred.
All 991 A/B/CI diagnostic receipt files and 25 corrective files remain intact.
Cleanup left zero containers and ports 3210/5173/7144/5436 free; observed free disk
stayed above 13 GiB, exceeding the 4 GiB reserve. The owned daemon/images remain.

Evidence: `.context/pr133-controlled-benchmark/failure-rca/corrective-validation-20261016T220428Z/`
(the invocation timestamps, not the directory label, record actual wall time).
This establishes local corrective validation, not B’s unique cause, a performance
result or exact-head CI/release qualification. The shipping gate remains in
`TODO.md`. No additional CI, commit, push, merge or deployment occurred.

## Main integration — 2026-10-16

The corrective tests and PR 133 features were rebased onto main
`e6710059313ceb8b90ad363acc61ca62297717ec` (#134–#136). Upstream runtime
unreachability diagnostics, busy-peer steering and the Node 24.22.0/dependency
upgrade are preserved. New CI jobs and discovery tests adopt that toolchain;
both independent control-plane image builds remain. The first integrated unit
contract correctly rejected its stale Node 24.6.0 expectation; it now requires
24.22.0. Discovery uses the current `createVitest(options)` API. The upstream runtime
version contract also expected one Node setup per workflow; it now checks exact
CI/E2E counts of two and Deploy/Durable counts of one, all at 24.22.0.

The earlier 421-input equality and original Docker receipt apply only to the
pre-rebase correction at `f43eff0f`, not this changed runtime/dependency closure.
Normal exact-head PR qualification is required; no new performance comparison
or historical-B cause is inferred from the rebase.

Both normal lifecycle workflows retain the pre-close browser ledger, structural
DOM JSON and masked screenshot through three explicit
`test-failures/full-slice-browser/*/{browser.json,dom.json,page.png}` paths, in
addition to upload diagnostics. No private-provider directory is added. A
workflow contract first failed for both missing allowlists, then passed with
these paths; job inventory and application semantics are unchanged.
