# WebKit missing-resource resurrection (2026-09-18)

**Status:** Compatible product race corrected; original failure attribution unavailable; no deployment

## First failure

The crop-mark frontend qualification passed 85 of 86 cases. WebKit established cached history, live controls, and one socket, but did not show `Orb doesn't exist` within five seconds after the test released a held history request. The unchanged first evidence remains in `test-failures/2026-09-18-crop-marks-full-frontend-webkit-missing-resource.md`.

The crop-mark change touched only the rename field wrapper in `OrbPage`; it did not change loading, polling, history, or socket ownership.

## Investigation findings

The original run did not trace requests or responses. Releasing the fixture promise did not prove that the refresh had entered the route or that WebKit received its 404. The metadata route also read mutable fixture state after `route.fetch()`, so a request's intended lifecycle was ambiguous. The evidence therefore cannot distinguish delayed request handling from a product transition failure.

Correcting those barriers exposed a compatible product race. `OrbConversation` polls metadata concurrently with history refresh. A successful metadata poll begun before the definitive history 404 could finish afterward and unconditionally clear `orbNotFound`. One controlled WebKit run reached this ordering: the missing page appeared transiently, then the stale response left one socket open and the socket-retirement assertion failed with `Expected: 0 / Received: 1`. Browser response observation does not force the corresponding React continuation ahead of effect cleanup, so this run proves reachability, not deterministic regression coverage or attribution of the original failure.

A history 404 is definitive for the mounted orb route. Metadata success from the same mount cannot reverse it; recovery requires navigation and a new load owner.

## Correction

`OrbPage` now owns missing-resource authority in a reducer. The state begins false for a valid load and becomes monotonic after either metadata or history reports 404. React applies queued reducer actions against the preceding result even when it batches their render, so ordered `missing` then stale `found` observations cannot revive the route before cleanup.

The browser regression now:

- snapshots metadata lifecycle when each request enters the route;
- waits until the stopped-cache refresh is held before publishing `running` metadata;
- establishes the live socket;
- holds an already-started successful metadata poll;
- releases and observes the exact history 404;
- then releases and observes the stale metadata response;
- requires the missing page, closed socket, and unchanged URL.

This remains an end-to-end integration gate, not the deterministic scheduler proof. The narrow reducer regression applies `missing` followed immediately by stale `found`, without rendering or cleanup between them. With the old clearing behavior it fails every invocation (`expected false to be true`); with the monotonic reducer it passes. No timeout increased.

## Validation

- Deterministic pre-fix reducer schedule: failed on `missing → found` with `expected false to be true`.
- Corrected focused reducer regression: passed.
- Final controlled browser integration: Chromium and WebKit passed.
- The preceding one-line monotonic fix passed the full frontend suite: 94 tests in 9 files. The final reducer ownership change was then covered by the focused two-engine integration and repository suite.
- Final `npm test`: 2,091 tests passed, 8 conditional skips, plus all infrastructure suites.
- Repository typecheck and lint passed; lint retained three existing warnings and one informational diagnostic.

## Related GitHub runs

[E2E run 35370665671](https://github.com/schani/pi-orb/actions/runs/35370665671) failed an unrelated project-poll fence assertion; both missing-resource engines passed. [E2E run 35377639910](https://github.com/schani/pi-orb/actions/runs/35377639910) failed three unrelated frontend readiness assertions; both missing-resource engines again passed. These runs provide no link to crop-mark rendering and cannot identify the cause of the untraced original failure.
