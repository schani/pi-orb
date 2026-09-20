# Composer typing stalls: browser cycle collection and transcript rerenders

## Status

Application fix implemented and locally validated; not deployed. No raw profile is committed.

The supplied Zen/Firefox profile remains outside the repository at `/workspace/uploads/04278b9a-840e-43bb-b2f3-c6b07a80d1c8/Zen 2026-09-20 12.03 profile.json.gz`. SHA-256: `10af62dca6d3165b264677f2b1d5bdec8e1711683258bce204e7e39d02e7195b`.

## Evidence

The 12.98-second, nominal 1 ms recording has two independent stall sources.

### Firefox parent process

The browser parent main thread spent **6,355.9 ms in 103 cycle-collector slices**. The two largest slices were **1,425.7 ms** and **1,292.6 ms**. Each cycle reported about **1.70 million visited ref-counted objects** and **6.0 million visited GC objects**. Sample stacks during delayed input are under `Incremental CC → nsCycleCollector_collectSlice`, mainly graph building and root scanning.

There are 61 paired `keydown` intervals. Their marker latency is **25 ms median, 726 ms p90, and 1,352.8 ms maximum**. This is not handler duration: [Gecko's marker implementation](https://github.com/mozilla/gecko-dev/blob/master/dom/events/EventDispatcher.cpp) defines DOM-event `latency` as event creation to the start of processing (`aStartTime - aEventTimeStamp`). The keydown handlers themselves were **0.22 ms median, 0.34 ms p90, and 3.15 ms maximum**. Thirty keydowns were created during parent CC slices. Sixteen queued during the 1,425.7 ms slice and were then dispatched in a burst with latency falling from 1,353 ms to 140 ms.

This establishes parent-process CC as the cause of the longest observed input-delivery stalls. It does not establish why the parent owned such a large graph. DevTools/profiling, the large browser session, extensions, and accessibility state remain possible contributors; content-process allocation is not itself parent-process allocation.

### Application content process

The foreground content main thread has seven long tasks: **231.8, 167.4, 165.9, 168.5, 176.2, 164.9, and 177.0 ms**, totaling **1,251.7 ms**. Six begin **2.8–35.6 ms** after identically sized **719,773-byte JSON GET** responses. URLs were stripped, so the endpoint is unknown: inbox polling and history repair are both plausible. The timing proves correlation with transcript rerenders, not which response path initiated them.

Six keydowns were created during these content long tasks and reached processing 37–140 ms later. Sampled stacks show synchronous React transcript rendering through Markdown and URL linkification. Inclusive presence within the 1,247 long-task samples was:

- React DOM: **96.7%** — ancestral render work, not exclusive cost;
- `react-markdown`: **38.0%**;
- `unified`: **36.2%**;
- `remark-parse`: **30.7%**;
- `linkify-react`: **31.7%**;
- `linkifyjs`: **30.5%**.

`linkifyjs/dist/linkify.mjs:145` was the deepest mapped application frame in **223 samples (17.9%)**. First-party correlated frames include `HistoryView.tsx:349,431-432` and `ToolActivity.tsx:90,285,347,409`. Nineteen of 20 content minor GCs occurred inside these tasks, totaling **74.1 ms**; their reports contain **9.82 million allocated nursery cells** and a summed **832 MB nursery bytes used at collection**.

The profile stores the application source as sanitized `https://<URL>` under host `pi-orb-1077475695242.us-central1.run.app` and has no application source map. A source-mapped build from the current checkout had matching generated line/column text at sampled positions, correlating frames such as generated `R0` with React `performWorkOnRoot`, generated `parse` with `unified` parsing, and generated `go` with `linkifyjs`. Matching positions do **not** prove that the deployed bundle hash equals the local build; these source names and lines are correlation, while the generated profile positions and library stacks are direct evidence.

## Rejected dominant causes in this capture

The page's 57 `input` handlers were **1.53 ms median, 1.92 ms p90, and 2.87 ms maximum**. Style work totaled **19.6 ms**; 299 synchronous reflows totaled **54.3 ms**, maximum **0.80 ms**. `ComposerCaret` appears in small layout stacks but cannot explain either stall class.

1Password is present and sampled in `onInput`, `drainPending`, and `processRecords`, but only **25 unique samples** contain its frames. Composer `focusin` lasted **1.9 ms**, versus 1.199 seconds in the earlier navigation incident (`docs/postmortems/2026-09-15-long-transcript-navigation.md`). It is not dominant here.

## Local fix and follow-up

Both response paths invalidated transcript rendering before this change. The local implementation now retains row and list identity when an inbox poll is unchanged. A same-session replicated snapshot reuses existing immutable history records and retains the records map when the ordered transcript is unchanged. Missing-middle repair is still applied even when cursor and head match; changed snapshots, transient live-block cleanup, and error cleanup also still apply.

This adds no polling, debounce, or production instrumentation. The controlled long-transcript browser regression reproduced two unnecessary renders before the fix (4 → 6); unchanged inbox polls and history repairs now add none. Validation passed 328 web unit tests, all 60 frontend-session Chromium tests, and web typechecking. E2E typechecking remains blocked by three pre-existing `document` references in the tab-focus test; changed tests introduce no errors.

These tests establish the identity contract, not field latency. A follow-up profile must determine whether the reported content long tasks disappear. Parent-process cycle collection requires separate clean-session investigation and is not fixed by reducing application rerenders.
