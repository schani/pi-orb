# Release validation blockers — 2026-09-16

## Boot hooks

[CI run 35124495457](https://github.com/schani/pi-orb/actions/runs/35124495457) failed in `runtime-restart-runs-resume-only`, iteration 11. Artifact `ci-dst-failure-traces-35124495457-1` preserved the original trace as `runtime-restart-runs-resume-only-1789577523951-11.json` (SHA-256 `731197403343918a4ee7404df10102b62b5e6ad2eed072d9a901929ce55624f9`). The local copy is under `test-failures/ci-35124495457-original/`.

Before correction, targeted replay reproduced `waitUntil timed out: orb left running for the restart`:

```sh
DST_REPLAY=test-failures/ci-35124495457-original/runtime-restart-runs-resume-only-1789577523951-11.json \
  npx vitest run apps/control-plane/src/domain/boot-hooks.dst.test.ts \
  -t 're-runs only resume when the runtime restarts inside one incarnation'
```

The trace shows the product authorized an unreachable restart after 11,597 ms of silence against a 10,000 ms grace. The provider stop then hit its explored operation deadline at virtual time 103,676.742 ms and returned retryable. Before a later attempt completed, the fixture's finite synthetic outage ended; fresh health corroboration answered, so the product correctly emitted `unreachable-restart-deferred reason=runtime_answered_corroboration` and remained running. The scenario incorrectly required every finite outage to produce a restart despite modeling retryable provider-stop failure.

The fixture now kills the runtime until the reconciler restarts its host. This forces the restart whose next boot the scenario inspects without suppressing provider deadline schedules or changing product behavior. The corrected scenario passed 20 schedules; the complete boot-hook DST file passed 17 tests. Control-plane typecheck, focused Biome, and whitespace checks passed.

Replaying the original trace against the corrected fixture does **not** validate or refute the correction: replay stops with scheduler divergence at entropy position 4097. The trace expected `poller random number: store latency: init or verify session`; the corrected branch instead created timer 1186, `poller sleep: poll loop tick`, with deadline 104,223.74448752713 ms. The old trace encoded the recovered-runtime branch removed by the fixture correction. It remains the exact pre-correction reproduction and causal record; fresh schedules cover convergence after the corrected branch.

Classification: scenario bug, resolved. A recoverable outage may recover after an attempted provider stop fails; a scenario asserting post-restart behavior must hold the runtime unavailable until restart.

## Find

[CI run 35122063557](https://github.com/schani/pi-orb/actions/runs/35122063557) and [CI run 35124495437](https://github.com/schani/pi-orb/actions/runs/35124495437) each failed when reopening Find after navigation to an archived orb. `useAppSearchSource` registered the changed route's source in a passive effect, leaving the committed route keyboard-interactive while Find still held the previous source. Command-K in that interval opened against the old registration; its later replacement correctly closed the dialog.

A controlled browser harness changes rendered route and source together, then dispatches Command-K from a `MutationObserver` at the route DOM commit boundary, before passive effects. It deterministically failed before the fix and passes now (`controlled-registration-prefx-red.log`, `controlled-registration-fixed-green.log`). Source registration, removal and unmount cleanup use layout effects, so the current source is installed in the same commit before browser interaction. The archived-orb case also waits for destination content, but that wait alone is not the lifecycle guarantee.

The controlled regression and original Find scenario pass together; 11 Find unit cases, web/E2E typechecks and focused Biome pass. The earlier 42-case frontend-session run predates the lifecycle fix and does not qualify it.

Classification: product lifecycle race, resolved. A committed interactive route and its Find source must become current in the same commit.

## Focused text fields

[CI run 35128640595](https://github.com/schani/pi-orb/actions/runs/35128640595) failed because the contrast helper immediately counted only enabled, visible fields while the asynchronous personal-instructions GET still kept its field disabled. Playwright locator counts do not wait for matches, so the count was zero.

The helper now waits for `fields.first().toBeVisible()` before counting, using the same enabled-and-visible locator predicate for both operations. No product CSS changed. The focused scenario passed (`.context/focused-fields-after-wait.log`); the CI failure is preserved in `.context/release-blockers/main-eb1ddd2-e2e-failed.log`.

Classification: test synchronization bug, resolved. A helper that requires at least one asynchronously enabled field must wait on that exact predicate before counting it.

## Project instructions

[CI run 35118219635](https://github.com/schani/pi-orb/actions/runs/35118219635) and [CI run 35122001212](https://github.com/schani/pi-orb/actions/runs/35122001212) timed out in Chromium because Save remained disabled after clearing project instructions. WebKit passed. On clean reopen, the retained snapshot first rendered editable; the passive activation effect then began its refresh. Chromium could edit during that render-before-effect window, after which the GET restored saved content and silently erased the edit.

The editor now synchronously gates editing and submission whenever an active clean document has not yet claimed its refresh. Dirty retained drafts still reopen without refresh. A deterministic server-render regression excludes effects and verifies that the activation render disables the textarea and Save while showing `Loading…`; it failed before the fix and passes now (`pre-fix-render-regression-final.log`, `fixed-render-regression-final.log`). The browser regression also holds the GET, proves the editor is disabled, releases it, then clears the refreshed content and proves Save becomes enabled. Both browser engines, the Config modal tests, typecheck, focused Biome and whitespace checks passed.

Classification: product race, resolved. A clean retained editor must become non-mutable in the activation render, not later in an effect, until its refresh owns the state.

## Session recovery

The final frontend run at source SHA `ae215d940de3f4b96121deb76fcd1a60c909bff261efa3af32ae13c4a2242d5e` passed 44 tests and failed session recovery: a global alert locator expected zero after recovery but found three (`.context/release-blockers/final-browser.log`). Those alerts were persisted model-error records intentionally supplied by the fixture. Earlier runs could reach the assertion before asynchronous history loaded and pass incorrectly.

The test now waits for all three history alerts before recovery, scopes disappearance to `.session-ribbon`, and verifies the history alerts remain afterwards. No product behavior changed. The corrected combined frontend run passed all 45 tests (`.context/release-blockers/corrected-browser.log`).

Classification: test synchronization and selector-scope bug, resolved. Recovery removes its session ribbon, not durable history errors; asynchronous fixture state must be observed before testing its preservation.

Final `npm test` passed 1,809 tests with five conditional skips plus infrastructure suites (`.context/release-blockers/final-unit.log`). Typecheck and lint passed. The combined Docker E2E passed 149 tests with no skips before the final focused-field and session-recovery test corrections (`.context/release-blockers/e2e.log`), so it does not qualify those corrections.
