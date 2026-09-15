# Long-transcript navigation: large JSON fetch and extension-amplified mount

## Status and evidence (2026-09-15)

Investigation only; no fix or deployment authorized. The user reported slow switching between long orb conversations, then supplied `Zen 2026-09-15 08.18 profile.json.gz` (2,532,558 bytes compressed). SHA-256: `1cbcaf989ef4558dd4877bfd075508b4211817d347c2dc0d443615edce2774e7`. The raw upload remains outside the repository at `/workspace/uploads/08eb41e9-6c14-446b-82d5-485bbe7a0386/Zen 2026-09-15 08.18 profile.json.gz`.

The preprocessed Firefox-profiler format records 12.096 seconds on an Apple M2 Max, macOS 26.6.2, Zen rv:155.0, at a nominal 1 ms sampling interval. The relevant foreground content main thread is PID 9818 / TID 84150732 (thread array index 5), innerWindowID 17179869187, sanitized page 60. Its marker targets include the product's `composer-input` and `composer-caret`. Other captured content threads are background tabs and must not be added to the foreground timing.

## Observed timeline

Times below are relative to `meta.profilingStartTime` (15798117.196958331 ms), not wall time.

| Offset | Observation |
| --- | --- |
| 1.810 s | A click targets a `span.trunc`; its handler takes only 0.36 ms. The sanitized target alone does not identify the orb. |
| 1.816–6.879 s | `Load 59703`, request ID 17179928887, is a GET returning HTTP 200 `application/json`. The Network marker records **25,208,690 response bytes** and **5.063 s** duration. URLs are stripped, so identifying this as the history endpoint is a strong source/timeline inference, not a recovered request URL. The marker's count is not proof of compressed wire bytes. |
| 1.827–3.365 s | `requestStart` to `responseStart`: **1.538 s**. This includes server/network waiting; the browser recording cannot isolate SQL execution or serialization. |
| 3.365–6.879 s | `responseStart` to `responseEnd`: **3.514 s** receiving the response. |
| 6.879–8.805 s | A **1.926 s** foreground `Awake` interval follows the response. This is not all Markdown or all application work. |
| 7.064–8.665 s | One **1.602 s main-thread long task** dispatches a `message` event and runs the application stack. A message event is not, by itself, evidence that this is a runtime WebSocket frame. |
| 7.454–8.654 s | Nested inside that task, `focusin` on `textarea.composer-input` takes **1.199 s**. Sample stacks identify **1Password – Password Manager**, including `onFocus → _onInputFocus → getFieldDesignation → getCollectionContext → settleAdded → flush → drainPending → processRecords → TreeWalker.nextNode`. The extension is traversing DOM during composer focus. |
| 8.665–8.796 s | Another **130 ms** main-thread long task follows. |

Thus this switch-shaped sequence spends about **seven seconds from click to the end of the post-load main-thread burst**, with approximately five seconds in the large response and a further substantial extension-amplified mount cost. This is not an instrumented navigation-to-first-paint or live-ready metric; the profile lacks application navigation marks.

The focus interval is **inside**, not additional to, the 1.602 s task. Its 1.199 s duration accounts for about 75% of that task. In that interval, 1,197 sampled stacks include 1Password functions; application functions also remain on the ancestral stack, so inclusive application samples cannot be treated as exclusive React/Markdown CPU time. Names and resources are sufficient to attribute this extension cost despite stripped script URLs and absent source contents/maps. Exact first-party minified-function attribution is not established.

### Post-response main-thread breakdown (follow-up analysis, 2026-09-15)

The 1.926 s `Awake` interval is not an opaque two seconds of rendering:

- **First 185 ms (6.879–7.064 s):** a 57.4 ms response-completion task (40 nominal 1 ms samples include `parse JSON`), then a 126.8 ms promise/microtask interval in minified application functions. Source inspection makes response validation/processing a plausible explanation for the latter, but absent source maps prevent exact function attribution.
- **Next 391 ms (7.064–7.454 s):** application execution and DOM mounting, with sampled `createElement`, `appendChild`, and attribute writes. A `getBoundingClientRect` stack synchronously flushes style/layout for 95.9 ms: 43.2 ms styling and 50.2 ms reflow, nested within that flush. The Styles marker reports **38,700 elements traversed, 38,699 styled, 28,990 matched**. This is measured document work, not a count of transcript messages or proof that every element belongs to the transcript. The remaining application work cannot be precisely divided into React versus Markdown from minified stacks.
- **Next 1,199 ms (7.454–8.654 s):** composer focus invokes 1Password's field detection and DOM traversal, with repeated layout reads/flushes. Those layout costs are already inside the extension interval, not additional time.
- **Following 151 ms (8.654–8.805 s):** dominated by a 130.1 ms refresh task, including 125.9 ms in `NotificationController::WillRefresh` and a nested 90.0 ms `DocAccessibleChild::ShowEvent`: browser accessibility-tree update/notification work, not another large Markdown parse. The remainder is small microtasks/rendering/transport setup.

These are approximate, non-overlapping timeline windows; sampled presence is not exact exclusive CPU time. Profiling overhead is included. The observed work reinforces bounding both response payload and mounted DOM, rather than attributing everything after download to Markdown.

## Source correlation

- `apps/web/src/pages/OrbPage.tsx` fetches metadata and full history together, waits for both, and remounts `OrbConversation` keyed by orb ID. Only the current load is retained.
- `apps/web/src/lib/api.ts` validates the full history response.
- `apps/control-plane/src/adapters/pg/store.ts` walks the whole history parent chain and returns complete records, including lossless native overflow.
- `apps/web/src/components/HistoryView.tsx` renders every grouped turn, with no viewport window.
- `apps/web/src/components/Composer.tsx` deliberately focuses the desktop composer on mount. Preserving that useful behavior while avoiding credential-field scanning is preferable to removing autofocus without evidence.

## Resulting proposal

Prioritize **bounded recent-history reads plus a small recent-orb cache**: the large response is the biggest directly measured delay, not just a speculative render bottleneck. Bound bytes as well as record count, because one tool output or attachment can be large. Keep full history accessible through backward paging and preserve snapshot/cursor correctness.

Keep DOM work bounded too. Mounting a complete transcript costs more than first-party rendering: browser extensions can scan the newly mounted tree. Viewport rendering and lazy closed tool bodies can reduce that exposure, but their benefits require measurement. A credential-scanning opt-out on the non-credential composer is a small candidate mitigation; validate actual 1Password behavior rather than assuming a `data-1p-ignore` attribute eliminates all mutation scanning. A same-orb, comparable capture with 1Password disabled on this site would isolate the extension's contribution, but would not fix the five-second large response.

Do not label the entire 1.6 s task “Markdown parsing,” assume the 1.54 s pre-response wait is SQL time, or treat caching alone as sufficient to remove remount cost. The revised proposals are in `docs/web-ui.md`; scope selection remains question 64 in `docs/open-questions.md`.

## Reproduction methodology

Parse the uploaded gzip as JSON; use `shared.stringArray` to resolve marker/function/resource names. Inspect `STATUS_STOP` Network data directly for `count`, `requestStart`, `responseStart`, and `responseEnd`. Pair phase-2/phase-3 DOMEvent markers by a per-name nesting stack; phase-1 markers already contain both endpoints. Resolve samples through `shared.stackTable.frame` and `frameTable.func`; a stack's parent is its index minus `prefixOffset` (zero means no parent). Resolve function resources through `funcTable.resource` and `resourceTable.name`. Preserve nesting when comparing intervals: summing ancestor and child durations would double-count extension work. No transcript content, raw profile, credentials, or recovered URLs are committed with this report.
