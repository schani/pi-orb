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
documentation; no fleet Find behavior was changed. At first neither observation established whether its cause was product selection
state or test synchronization. The missing wait for results after the final query
fill was a diagnostic lead; the controlled reproduction below establishes it.

The original GitHub log remains the primary evidence. A local copy is retained
at `.context/native-fixture-fix/e2e-failed.log`. No assertion, timeout or retry
policy was changed, and no diagnostic rerun was attempted in this task.

## Deterministic reproduction and correction — 2026-09-15

The dashboard loads its orb lists independently after route navigation. The
original test waited for the dashboard DOM, not for its orb results. Holding
`/api/v1/projects/frontend-fixture-project/orbs` behind a test-owned promise
reproduced the exact original URL failure before changing the selection sequence:

1. Navigate from the orb to the focused project, reopen Find, and fill the query.
2. While the response is held, assert that the sole result is the project.
3. Press ArrowDown: the one-element result list wraps to the project.
4. Release the orb response and wait for the orb link, then press Enter. It still
   activates the project because arrival correctly preserves the selected key.

This forced schedule failed with the same expected-orb/received-project URL. It
establishes a test synchronization defect, not a requirement to predict future
results or replay old key presses. The product's partial-loading behavior and
selection retention match `docs/dashboard-find.md`.

The corrected browser test retains the response gate and asserts the visible
loading diagnostic. It explicitly proves the early ArrowDown selects the sole
project, releases the response, waits for the orb's native href, verifies that
arrival preserved the project selection, then presses ArrowDown and checks the
orb is active **before** Enter. Archived-orb activation likewise waits for its
active native href. Cleanup always releases the held response. No product code,
sleep, retry or timeout was changed; URL/draft/route assertions remain strict.

Local evidence in `.context/find-navigation/`:
- `held-list-red.log`: deterministic pre-fix failure with the original URL mismatch.
- `held-list-green.log`: corrected controlled schedule passes.
- `frontend-session.log`: all 34 frontend-session browser cases pass together.

All 11 search core/dialog unit tests and E2E TypeScript checking passed. Biome
passed with the pre-existing unrelated non-null-assertion warning at line 769.

## GitHub verification

For fix commit `3eec79a`, CI
[35021851741](https://github.com/schani/pi-orb/actions/runs/35021851741) passed.
E2E [35021851799](https://github.com/schani/pi-orb/actions/runs/35021851799)
passed all 34 frontend-session cases, including this controlled Find schedule.
The overall run failed independently in PostgreSQL setup because host port
55434 was occupied: 62 tests passed and 55 store cases were unrun. That failure
was not rerun and is preserved separately in
`docs/postmortems/2026-09-15-postgres-e2e-port-collision.md`. This qualifies the
Find correction, not the complete release.

## Outcome and rule

The Find synchronization defect is corrected and locally/GitHub validated; the original
GitHub failure remains preserved, not relabelled green. No second production
workflow was dispatched. The separately recorded WebKit issue remains open.
Correctness requires deterministic result/selection synchronization, not a sleep,
longer timeout or passing rerun.
