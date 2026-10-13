# Cached input label

Updated the test before changing the UI label. The cached-input series was absent under the new name, while the old label remained. Renamed only the presentation label; counts and API fields are unchanged. Six usage unit tests and the Chromium usage E2E pass.

Initial failure:

```text

 RUN  v4.1.11 /workspace/repo

 ❯ apps/web/src/lib/usage.test.ts (6 tests | 1 failed) 72ms
     ✓ keeps large summary counts compact 57ms
     ✓ builds dense rolling periods and clamps calendar month subtraction 3ms
     ✓ sums volume including cache and weights cache share by prompt tokens 1ms
     × fills every interval, preserves token composition and reconciles use/model lines 7ms
     ✓ limits model lines to five leaders plus Other without discarding usage 2ms
     ✓ ranks the selected measure, keeps equal names distinct, and represents empty data 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  apps/web/src/lib/usage.test.ts > usage presentation > fills every interval, preserves token composition and reconciles use/model lines
AssertionError: expected undefined to deeply equal [ [ 1791849600000, 80 ], …(1) ]

- Expected:
[
  [
    1791849600000,
    80,
  ],
  [
    1791850500000,
    0,
  ],
]

+ Received:
undefined

 ❯ apps/web/src/lib/usage.test.ts:77:73
     75|     const token = usageTimeline(data, "token_kind");
     76|     expect(token.series).toHaveLength(4);
     77|     expect(token.series.find((s) => s.name === "Cached input")?.points…
       |                                                                         ^
     78|       [at, 80],
     79|       [at + 900000, 0],

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
   Start at  20:11:46
   Duration  934ms (transform 68ms, setup 0ms, import 649ms, tests 72ms, environment 0ms)
```
