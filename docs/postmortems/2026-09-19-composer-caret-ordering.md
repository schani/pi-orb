# WebKit caret measurement preceded input normalization

## Impact

The pre-deployment consolidation E2E run passed 214 tests and failed one desktop WebKit composer geometry assertion. An earlier complete mobile run had passed. This was not dismissed as noise; deployment remained blocked pending a causal reproduction.

## Cause

Typing `!` switches an empty composer into shell mode and normalizes the controlled textarea back to empty. The caret overlay's native target listener measured the transient `!` before React's root listener restored the controlled value. The React text prop remained empty, so its text-dependent layout effect did not run again. A later native selection event repaired the stale measurement; the test sometimes observed it first.

The original coordinates were exact: editor/baseline caret `271.390625`, stale caret `279.1875`, a one-character displacement. Sidebar width was fixed and no downloaded font was involved.

## Deterministic reproduction

A capture-phase gate holds `select` and `selectionchange` notifications while the original geometry assertions run. With the original listener, the textarea is empty with selection zero, but the caret mirror still contains `!`. Releasing selection delivery restores the expected position. The tracked gated test reproduces the original coordinates without relying on timing luck.

## Decision

Measure input at document bubble, after React's root listener normalizes and restores the controlled value. Filter by the owned textarea and remove the listener on cleanup. Other selection, composition and layout measurements remain unchanged.

Rejected: queueing a microtask from the native target listener. WebKit experimentally ran that microtask before React's listener; the same deterministic regression still failed. Neither timers nor a looser assertion establish the required ordering.

## Evidence

- `.context/consolidation/e2e-caret-first-complete.log`: original failure and stack; all runtime/security E2E passed.
- `caret-held-before-fix.log`: held-selection reproduction with DOM, mirror, coordinates and event sequence.
- `caret-microtask-ordering.log`: rejected microtask experiment.
- `caret-tracked-regression-original.log` / `caret-tracked-regression-fixed.log`: same tracked test and unchanged geometry assertions, failing with the original listener and passing with the document-bubble listener.
- `caret-mobile-fixed.log` / `caret-native-editing-fixed.log`: 22 mobile tests and two native caret/mention tests passed.

All `caret-*` evidence is under `.context/consolidation/`. Final qualification is recorded in `docs/testing.md`.
