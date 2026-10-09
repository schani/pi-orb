# Headline cancellation fixture used hard navigation

## Evidence

[PR 66 CI run 37726436385](https://github.com/schani/pi-orb/actions/runs/37726436385), shard 1, reported a WebKit internal `page.goto` failure in `scope replay result` at its third hard document navigation. Historical WebKit internals remain unproved; prior `/tmp/pr66-monitor-d90a2a5/artifacts` may not survive host preemption. This correction does not establish the browser failure's root cause.

The confirmed harness defect was semantic: four hard navigations destroyed the JavaScript document holding the old React owner. Delivering held replies afterward could not exercise cancellation within that document. A tests-first document-request assertion reproduced this: expected one, received five (`.context/pr66-headline-navigation/document-red.log`).

## Correction (2026-10-08)

Use native dashboard/orb SPA links. Before returning, require transcript unmount and server-observed live-socket teardown; on return, require transcript mount and one live connection. Require exactly one document request across all transitions. Existing boot diagnostics capture transition checkpoints and bounded browser/network observations.

Keep old replies held until a fresh request for the reused identity in the new session has published. Identify the fresh request by session, not request order. Return may use enriched history or POST to the backend cache; release non-stale cache requests without imposing either path. A cached view may briefly request its prior session before the live snapshot replaces it.

No product change, navigation retry, timeout increase or assertion removal for stale publication, replay or result replacement.

## Validation

Preserved logs under `.context/pr66-headline-navigation/`:

- `scope-green.log`: failed intermediate SPA fixture; return requests remained held.
- `scope-cache-green.log`: interrupted, not a completed pass.
- `all-headlines.log`: four Chromium passes; scope failed an invalid exact remount-POST count; WebKit executable missing after preemption.
- `corrected-headlines.log`: six assertions passed but four unhandled prior-session assertion errors; not green.
- `session-fenced-green.log`: both corrected scope cases passed with no unhandled errors.
- `final-headlines.log`: all ten frontend headline cases passed on Chromium/WebKit.
- `lifecycle-green.log`: all 28 isolated header lifecycle cases passed on Chromium/WebKit. `PI_ORB_E2E_BACKEND=process` skips unrelated Docker image setup; these cases use controlled browser fetch/observer fixtures, not a runtime backend.

Root `npm run typecheck` and `npm run lint` passed (`typecheck.log`, `lint.log`); lint reported 111 warnings and 16 infos, no errors.

Managed browser engines/dependencies were installed after discovering the missing WebKit executable. This is focused corrective stabilization under the 2026-10-05 UI exception, not full release qualification or proof of historical WebKit internals.
