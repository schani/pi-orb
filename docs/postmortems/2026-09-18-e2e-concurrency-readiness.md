# E2E frontend fixture readiness races (2026-09-18)

**Status:** Root-caused and corrected; full local qualification passed

## First failure

The first full suite under the concurrent-project configuration ran for 625.97 seconds: 172 tests passed and one failed. `e2e/frontend-session.e2e.test.ts` failed `loads addressed orb project context omitted from the default list` because Playwright could not find the `Frontend playground` `.orb-index .ix-project` within its unchanged five-second assertion window:

```text
expect(locator).toBeVisible() failed
Locator: locator('.orb-index .ix-project').filter({
  has: getByRole('heading', { name: 'Frontend playground', exact: true })
})
Timeout: 5000ms
Error: element(s) not found
```

The run used the rejected configuration that started three workers and overlapped frontend work. Its complete first-failure evidence is `.context/e2e-concurrency/full.log`.

## Second full-run failure

The next full qualification run failed `shares project header and validates General settings at #/orbs/frontend-fixture-orb` after 5.530 seconds. The dashboard variant of the parameterized test passed; the orb-route variant reached the unchanged five-second assertion deadline before its project header existed:

```text
expect(locator).toBeVisible() failed
Locator: locator('.project-head').first().getByRole('button', { name: /^Configure / })
Timeout: 5000ms
Error: element(s) not found
```

The run was still completing lifecycle files when this evidence was recorded. Its log is `.context/e2e-concurrency/full-qualified.log`. The failure occurred after the separately reported background test overlap; the available evidence does not connect them.

## Third full-run failures

The final diagnostic run started at `2026-09-18T06:11:35Z` and ended at `2026-09-18T06:21:06Z`: 171 tests passed and two failed in 570.58 seconds. All lifecycle tests passed. `frontend-session` reached the OAuth-return dialog assertion after 5.615 seconds without the dialog, and `project-instructions-frontend` reached its first Configure-button assertion after 6.298 seconds without the dashboard controls. The complete evidence is `.context/e2e-concurrency/full-final.log`.

Both failures again navigated a new page and started UI assertions without awaiting the successful initial `GET /api/v1/projects` response. Vite module loading under three-worker CPU load consumed most or all of the assertion window before the request completed.

## Cause

The failures started a UI assertion after navigation but before the fixture response that enabled the asserted state. In the first case, the browser loads orb metadata to learn its project ID, receives a default project list from which the fixture deliberately removes that project, and only then issues the direct addressed-project GET. In the second, `.project-head` depends on the mocked default-project-list GET, but the test asserted it immediately after navigation. Suite load let each dependency chain outlive its assertion window. The evidence establishes missing test readiness barriers; it neither demonstrates a UI defect nor rules one out beyond these observed schedules.

## Correction

The addressed-project fixture now gates its direct GET. The test waits until that request arrives, proves the filtered default list has not rendered the project, arms a wait for the exact response, releases the gate, awaits the response, and only then asserts the project controls and title.

The shared-header fixture now applies the same barrier to its default-project-list GET for both parameterized routes: observe the request, prove no project header exists before release, arm the exact response wait, release, await, then assert. Both request observations use Playwright's bounded `waitForRequest`, not an unbounded fixture promise.

Ordinary new-page frontend fixture navigations that immediately require loaded dashboard or project controls now use one helper. It arms an exact successful `GET /api/v1/projects` response wait before `page.goto` and awaits navigation and response together with `Promise.all`, so neither rejection is temporarily unhandled. Same-page navigation and reloads do not use it. Tests that intentionally pause or fail project reads retain raw navigation and their exact protocol barriers, including the two negative-before-response checks above. No timeout increased, existing assertion weakened, or UI code changed.

The focused addressed-project test passed twice: once in 4.39 seconds (7.30-second invocation) and again in 4.86 seconds (6.41-second invocation). The shared-header focused validation then passed both route variants without timeout changes:

```sh
npx vitest run --config e2e/vitest.config.ts e2e/frontend-session.e2e.test.ts -t 'shares project header and validates General settings'
```

The invocation passed 2 tests with 53 filtered in 7.40 seconds.

After adding the shared initial fixture barrier, the complete `frontend-session` and `project-instructions-frontend` files passed together: 57 tests in 137.91 seconds. The two formerly failing tests completed in 1.322 and 3.888 seconds.

The final complete Docker-backed suite passed all 173 tests in 23 files in 577.68 seconds, from 06:27:46 to 06:37:24 UTC on 2026-09-18. It used the shared fixture barrier, one frontend thread, and two lifecycle forks with distinct fixture ports. Evidence: `.context/e2e-concurrency/full-accepted.log`. Earlier failed-run logs remain preserved; no deployment was performed.

Browser tests must await the protocol or fixture response that enables the asserted state; navigation completion is not a substitute for a dependency readiness barrier.
