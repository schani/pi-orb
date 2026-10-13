# Token usage study phone target

First run: `node design-prototypes/token-usage.smoke.mjs`.

```
AssertionError [ERR_ASSERTION]: 44px controls 3/390:
[{"tag":"BUTTON","h":28,"font":13}]
    at design-prototypes/token-usage.smoke.mjs:160:16
```

The project-header `.action` selector's 28px minimum overrode the phone rule's generic `button` minimum. Add `.action` to the phone selector, retaining 44px targets. This is a prototype CSS defect, not a historical flaky test.

Corrected validation passes all five proposals at 1440, 390 and 320px, including every visible control's minimum target size. Screenshots and first-run log were captured at `/tmp/token-usage-first-failure.png` and `/tmp/token-usage-smoke-first.log`; the assertion above preserves the failure evidence in the repository.
