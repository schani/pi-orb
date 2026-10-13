# Token usage refinements test API

First run: `node design-prototypes/token-usage-refinements.smoke.mjs`.

```
TypeError: page.locator(...).isFocused is not a function
    at design-prototypes/token-usage-refinements.smoke.mjs:81:51
```

The new smoke test called a nonexistent Playwright Locator method. Replace it with `locator.evaluate(el => el === document.activeElement)`, preserving the required focus-return assertion. This deterministic harness error was not a product failure or a flaky schedule.

Corrected validation passes every icon/layout, period and breakdown, accounting reconciliation, bucket detail, focus/dismissal and desktop/phone checks. First evidence is retained above; the original screenshot/log were captured at `/tmp/token-usage-refinements-harness-api-failure.png` and `/tmp/token-usage-refinements-harness-api-failure.txt`.
