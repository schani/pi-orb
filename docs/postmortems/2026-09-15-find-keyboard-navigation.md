# Fleet Find keyboard navigation E2E failure — 2026-09-15

## Evidence

GitHub E2E run [35013933184](https://github.com/schani/pi-orb/actions/runs/35013933184)
on `995f7df0f984589645167c94f942f13da9db709d` completed with 116 passed / 1 failed.
The failing case was `opens fleet Find from the orb composer and navigates with
native result links` in `e2e/frontend-session.e2e.test.ts:2069`.

After navigating to the fixture project, the test reopened Find, filled
`Frontend Playground`, then immediately pressed ArrowDown and Enter. The URL
remained `http://127.0.0.1:5173/#/projects/frontend-fixture-project` rather than
the expected `http://127.0.0.1:5173/#/orbs/frontend-fixture-orb` for the entire
five-second assertion window. The captured accessibility snapshot showed the
dashboard. This is not a WebKit process crash; mobile and personal-instructions
browser cases passed in this run.

The earlier production attempt `35004543252` passed this case. The corrected
commit changes only the native-image validation broker, its contract test and
documentation; no fleet Find behavior was changed. Neither observation clears
this failure or establishes whether its cause is product selection state or
test synchronization. In particular, the test does not wait for a selected
result after its final query fill; that is a diagnostic lead, not a proven cause.

The original GitHub log remains the primary evidence. A local copy is retained
at `.context/native-fixture-fix/e2e-failed.log`. No assertion, timeout or retry
policy was changed, and no diagnostic rerun was attempted in this task.

## Outcome and rule

No second production workflow was dispatched. This failure independently blocks
release alongside the previously recorded WebKit issue. Native acceptance of
the personal-instructions fixture correction passed, but it is not an E2E pass.
Correctness requires deterministic result/selection synchronization, not a sleep,
longer timeout or passing rerun. Investigation is tracked in `TODO.md`.
