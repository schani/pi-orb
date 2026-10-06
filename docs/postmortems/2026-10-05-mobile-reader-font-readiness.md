# Mobile reader offset and font readiness (2026-10-05)

## Historical evidence

GitHub E2E run `37384177586`, source `c5ae51c`, reported Chromium's cancelled-touch/momentum case with delivered scroll as failed in 1,249ms. Cancellation at the job's 40-minute limit lost the assertion summary; neither the assertion nor its values can be recovered. Runtime and mobile test code matched the prior passing run. The probe below identifies a real test defect, not the unknowable historical assertion.

## Controlled reproduction

Used only the existing Vite frontend fixture and installed Playwright Chromium build 1243. No Docker, hosted rerun, production operation, or browser installation. Ran the frontend Vitest project with the mobile file and Chromium cancelled-touch name filter.

Held the existing `/fonts/*.woff2` responses until either before or after capturing the reader offset. Waited for all six fixture images. Retained the original tail-distance and exact absolute-offset assertions, with both delivered-scroll controls. A fixture-local scrollTop setter classified stack provenance as anchor helper, tail follower, or fixture; immediate failure capture included assertion, stage, saved/current geometry, visible row offsets, font status, writes, and pin edges. No generic reporter was introduced.

The four-case probe produced three passes and one failure: fonts released **after** capture with scroll delivered. Saved scrollTop was **1698**, actual **1718**; scrollHeight grew from **2752** to **3574** (including the 800px spacer), clientHeight stayed **754**. Fonts changed from loading to loaded. The same first visible history row remained at offset **-725**. Its only non-fixture scroll write was the history anchor helper's **+20px** compensation. The sole pin edge was `released:touch`; no tail repinning occurred. Absolute position changed while the captured visible-row anchor stayed fixed.

A separate four-case probe held detail responses until before versus after capture, with fonts ready, retaining both scroll-delivery cases and the exact assertions. All four passed. This schedule did not reproduce a detail-arrival defect; it does not qualify every possible detail/layout interleaving.

Local evidence, including the controlled-red source and unmodified first-failure log, is retained under `.context/consolidation/mobile-controlled-probe/`: `fonts-red-source.ts`, `fonts-red.log`, `details-source.ts`, `details.log`, and `barrier-green.log`. First red source SHA256: `ae81279e6785791be76e026eff7abf87e7902319ec59158c59172b54ea751f8d`; log SHA256: `0ebeb3903d38762ad94f24579670a51a9854a86ba79db7747e871a42bd563c82`.

## Correction

The cancelled-touch test now deliberately gates a requested fixture font, releases it after media readiness, and awaits `document.fonts.ready` before establishing the tail and capturing the reader offset. Both original scroll-delivery cases and both exact assertions remain. The corrected focused Chromium run passed both cases. Product code is unchanged: legitimate anchor compensation must not be disabled to satisfy an absolute-offset assertion. Repository typecheck and lint passed (lint reported 53 warnings and four informational diagnostics); the changed test passed its isolated Biome check with no diagnostics. WebKit and full E2E were not run.

Decision: absolute-scroll assertions require the known font-layout readiness barrier, not two animation frames alone. No timeout or tolerance was increased. This local correction does not qualify deployment; full hosted E2E remains required after review.

## Separate job cancellation

The job ran 40m21s; its test step ran 38m50s. All 44 common completed files slowed down, totaling 268.825s more than the previous run; the previous complete suite took 34m15s. Tests continued after the mobile failure, so this was budget exhaustion, not evidence of a mobile hang. Proposed separately: a 60-minute job budget and Vitest 4's supported `--bail 1` to stop on the first failed file and preserve the final failure summary. Neither workflow change was implemented in this task. Test timeouts remain unchanged; this proposal cannot clear the mobile failure or replace release qualification.
