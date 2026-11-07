# Transcript charts browser qualification failures (2026-10-13)

First-failure record, moved from the former `test-failures/` ledger. `e2e/transcript-charts-frontend.e2e.test.ts`, Chromium and WebKit, frontend fixture orb `frontend-charts`. The 2-CPU VM restarted repeatedly; `/tmp` evidence of the first investigation was lost, so findings are recorded from the session.

## 1. Label hover did not isolate a series (product race; fixed)

Intermittent (about 60–80% after instrumentation, first seen 1 in 3): hovering the `us-west-2b` end label left 0 of 5 lines dimmed. The pointer was on the label `<text>`, but pi-orb's Vega `pointerover` listener never fired; Vega's own tooltip still worked. The zones chart mounted views `y51m` and `utgc` (React StrictMode double effect); `utgc` was superseded and finalized, yet the on-screen `<svg>` was `utgc`'s. `vega-embed` clears and reuses its container and Vega's `domChild` reuses an existing `<svg>`, so whichever overlapping mount initialized last owned the visible chart. Finalizing it removed pi-orb's listeners but not Vega's tooltip handler.

Fix: each mount owns a fresh host element that its cleanup detaches (`apps/web/src/components/ChartRows.tsx`, `ownHost`). The browser test asserts one host per chart canvas. After the fix: 8/8 Chromium runs.

## 2. WebKit `toHaveCount` received `undefined` (unexplained)

```
webkit: renders code-mode charts …
Error: expect(locator).toHaveCount(expected) failed
Expected: 0
Received: undefined
```

The run overlapped the lazy-image/transcript/pairing WebKit suite on the same 2-CPU VM, shortly before a host restart. Not reproduced in 12 later serial runs. Root cause not established; resource exhaustion is suspected but unproved. Covered by the UI exception (`docs/testing.md`, approved exceptions).

## 3. Chromium browser disconnected during initial load (environment)

`Frontend readiness failed: page.waitForRequest: Target page, context or browser has been closed … "browser":{"connected":false,"disconnections":1},"page":{"closed":true,"crashes":0}` immediately before a host restart. No product involvement.

## 4. Console assertion: unrelated messages, then real Vega warnings

The first console check failed on app-wide messages unrelated to charts that vary by run and engine (WebKit `interactive-widget` viewport key, the development live socket closed by StrictMode, notification prompting). A keyword filter then matched the orb id `frontend-charts` inside a WebSocket URL. The check now records uncaught page errors and Vega logger output only.

That stricter check found real spec defects, deterministic in both engines:

- `WARN Infinite extent for field "t": [Infinity, -Infinity]` — hover layers filtered to empty data. Pinning an explicit time domain produced `WARN Conflicting scale property "domain"`. Fixed by keeping the hover rule/dots' data and toggling opacity through the hover selection.
- `WARN Dropping "fit-y" because spec has discrete height.` — bar charts used a band step with width fitting. Fixed with a numeric height (20px per bar).

`apps/web/src/lib/chart-spec.test.ts` compiles every chart form with Vega-Lite and requires zero warnings. After both fixes: 4/4 serial runs green in Chromium and WebKit.

## Rules

- Console assertions record uncaught page errors and library logger output, never keyword filters over all console text.
- Chart specs compile with zero Vega-Lite warnings.
