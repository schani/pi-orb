# Transcript charts browser qualification (2026-10-13)

`e2e/transcript-charts-frontend.e2e.test.ts`, Chromium and WebKit, frontend fixture orb `frontend-charts`. The VM (2 CPUs) restarted repeatedly during this work; `/tmp` evidence of the first investigation was lost with one restart, so its findings are recorded here from the session.

## 1. Label hover did not isolate a series (product race; fixed)

Intermittent (about 60–80% after instrumentation, first seen 1 in 3): hovering the `us-west-2b` end label left 0 of 5 lines dimmed. Hit-testing showed the pointer on the label `<text>`, but pi-orb's Vega `pointerover` listener never fired; Vega's own tooltip still worked. Per-view instrumentation: the zones chart mounted views `y51m` and `utgc` (React StrictMode double effect); `utgc` was the superseded mount and was finalized, yet the on-screen `<svg>` was `utgc`'s. `vega-embed` clears and reuses its container and Vega's `domChild` reuses an existing `<svg>`, so whichever overlapping mount initialized last owned the visible chart. Finalizing it removed pi-orb's listeners but not Vega's tooltip handler.

Fix: each mount owns a fresh host element that its cleanup detaches (`apps/web/src/components/ChartRows.tsx`, `ownHost`). The browser test asserts one host per chart canvas. After the fix: 8/8 Chromium runs.

## 2. WebKit run: `toHaveCount` received `undefined` at the phone-width step (unexplained)

```
webkit: renders code-mode charts …
Error: expect(locator).toHaveCount(expected) failed
Expected: 0
Received: undefined
```

This run overlapped the lazy-image/transcript/pairing WebKit suite on the same 2-CPU VM, shortly before a host restart. Not reproduced in 12 later serial runs. Root cause not established; resource exhaustion is suspected but unproved (UI exception, `AGENTS.md`).

## 3. Chromium: browser disconnected during initial load (environment)

`Frontend readiness failed: page.waitForRequest: Target page, context or browser has been closed … "browser":{"connected":false,"disconnections":1},"page":{"closed":true,"crashes":0}` immediately before a host restart. No product involvement.

## 4. Console assertion: unrelated messages, then real Vega warnings (test corrected, spec fixed)

The first console check failed on app-wide messages unrelated to charts that vary by run and engine (WebKit `interactive-widget` viewport key, the development live socket closed by StrictMode, notification prompting). A keyword filter then matched the orb id `frontend-charts` inside a WebSocket URL. The check now records uncaught page errors and Vega logger output (`WARN …`/`ERROR …`, or "vega").

That stricter check found real spec defects, deterministic in both engines:

- `WARN Infinite extent for field "t": [Infinity, -Infinity]` — hover layers filtered to empty data. Pinning an explicit time domain instead produced `WARN Conflicting scale property "domain"` (numeric vs datetime-signal forms). Fixed by keeping the hover rule/dots' data and toggling opacity through the hover selection.
- `WARN Dropping "fit-y" because spec has discrete height.` — bar charts used a band step with width fitting. Fixed with a numeric height (20px per bar).

`apps/web/src/lib/chart-spec.test.ts` now compiles every chart form with Vega-Lite and requires zero warnings; it fails against the step height. After both fixes: 4/4 serial runs green in Chromium and WebKit.
