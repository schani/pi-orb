# Usage mock frontend

Tests first: `usage-fixture.test.ts` failed because the generator did not exist (`/tmp/mock-usage-first-red.log`). Added deterministic quarter-hour events, half-open aggregation, reconciled bucket/orb totals and a nameless orb. Two unit tests and web typecheck pass.

Live Chromium smoke on the running Vite frontend used the mock backend without request interception: all four periods, model breakdown, rankings and 390/320px containment passed, with no page errors. Output: `/tmp/mock-usage-live-smoke.log`; screenshots: `/tmp/mock-usage-live-{1440,390,320}.png`.

Preview only; no production data, provider calls or deployment.
