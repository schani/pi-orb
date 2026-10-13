# Token usage comparison study

## Initial generated HTML

First smoke run: `[data-ready]` was absent. Browser diagnosis: `SyntaxError: Invalid or unexpected token`; the generated HTML contained 19 `<script>` openings and leftover `__BUNDLE__` placeholders.

Cause: the build script used bundled JavaScript as a `String.replace` replacement string. Vega's literal `$&` / related sequences were interpreted as substitution tokens. Use replacement callbacks so the bundle is inserted literally. First evidence: `/tmp/token-usage-comparison-initial-load-failure.txt`, `/tmp/token-usage-comparison-smoke-first.log`.

## Dense axis

Next run:

```
Expected: 96
Received: 6
locator('[data-timeline] g.mark-rule.role-axis-tick').last().locator('line')
```

Vega's `AxisTicks` calls `validTicks` with its configured count even when explicit tick values are supplied. The shared default was six. Set the dense override's tick count to its explicit values' length. Vega tick values are Date objects; coerce `datum.value` to epoch milliseconds for sparse-label index matching and the last-label equality. Preserve the six-tick default when no override is supplied.

Evidence: `/tmp/token-usage-comparison-axis-selector-failure.txt`; the regression now asserts actual 96/168/120/183 SVG ticks and labeled endpoints.

## Font measurement

Visual inspection found clipped orb labels. Before the embedded JetBrains Mono face loaded, Vega cached proportional fallback-font measurements; actual label bounds exceeded the cached extents after font arrival (e.g. Provider cache audit began 18px left of the SVG).

The standalone study loads the shared chart face before its first mount. This corrects the study's immediate-first-render ordering; no historical in-chat font fix is claimed. The browser regression checks bar-label containment. No assertion was weakened or timeout enlarged.

Corrected shared-builder/unit and Chromium study tests pass. Existing Chromium transcript-chart E2E also passes. WebKit was not run.
