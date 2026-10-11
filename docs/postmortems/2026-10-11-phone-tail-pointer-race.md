# Phone tail released by a pointer press before the auto-scroll event (2026-10-11)

## Symptom

`e2e/frontend-mobile.e2e.test.ts` "keeps tail during a stationary pointer with inside/outside/cancel release" intermittently failed its tail poll with `distance` 940 (expected ≤ 1) on macOS Docker Desktop: 5 of 21 isolated runs and 1 of 3 full-file runs on unmodified `origin/main` (Chromium in the isolated runs, WebKit in the full-file run). CI passed. Evidence: `.context/phone-flake/` in workspace `dar-es-salaam` (`base-tally.txt`, `instrumented/fail-2.json`).

## Cause

A real product race, not test synchronization:

1. A late font load grew the transcript. The `ResizeObserver` tail follower in `apps/web/src/pages/OrbPage.tsx` wrote the new bottom offset and recorded it as the pending own-write offset (`autoScrollYRef`).
2. Browsers deliver that write's scroll event in the next frame. The test's pointerdown landed between the two.
3. `pointerIntent` cleared the pending own-write offset, a leftover from when a pointer press counted as reader intent; 37f72af made stationary presses neutral but kept the clear.
4. The 800px spacer was appended. The delayed scroll event then arrived at the old bottom: no own-write offset to match, geometry protection suspended during the pointer gesture, not within 48px of the new bottom, so `isPinnedAfterScroll` returned false (`scroll_pin released:scroll`, scrollY 2021, contentHeight 3575). The spacer (800) plus a later 140px growth gave 940.

A user tapping the transcript while content arrives hits the same schedule and loses tail following.

## Fix

`pointerIntent` no longer clears the pending offset. A scroll event at exactly the offset the app wrote is the app's write regardless of pointer state; real drags change the offset and still resolve as reader movement. The next scroll event clears the offset as before. Rule: `docs/web-ui.md`.

## Validation

New test "keeps tail when a stationary pointer precedes the auto-scroll event" forces the schedule: a second `ResizeObserver`, registered after the page's, runs after the tail write in the same frame and dispatches pointerdown plus the 800px spacer before the scroll event. Without the fix it failed 5 of 5 runs on both Chromium and WebKit (`distance` 940, trace `released:scroll` at the pre-spacer bottom); with the fix it passed 5 of 5. With the fix the original stationary-pointer tests passed 20 of 20 isolated runs (all six cases); the full mobile file passed except the two WebKit tests that also fail locally without the change and pass on CI (`TODO.md`, local macOS failures). Web unit tests (664), typecheck and lint pass. Evidence: `.context/phone-flake/regression/` in workspace `dar-es-salaam`.
