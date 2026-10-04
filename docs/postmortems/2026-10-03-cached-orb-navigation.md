# Cached orb navigation: remount and extension costs

## Status and evidence (2026-10-03)

Investigation only; no implementation, tests or deployment authorized. The user reports switches exceeding half a second between two memory-cached conversations. The capture shows no multi-megabyte history response around the switch; cached data still requires a fresh metadata check and a new conversation mount.

Upload: `/workspace/uploads/cc227ebe-8cfa-43a8-b899-7e238d50b3b5/Zen 2026-10-03 17.06 profile.json.gz`. SHA-256: `8e8ce8106820498ad8a90dec10a45723e04c78881a730f04e3dbdcf6c2cdc99c`. No raw profile or transcript content is committed.

The 4.75 s recording uses nominal 1 ms sampling on an Apple M2 Max. Attribution below uses foreground thread array index 5, PID 31168 / TID 137218340, tab 18, innerWindowID 1954210119700, sanitized page 152; background threads are excluded. Offsets use its first sample, 322185620.011 ms, as zero. `profilingStartTime` is 0.463 ms earlier.

## Observed timeline

| Offset | Evidence |
| --- | --- |
| 2.188–2.194 s | Click on `span.trunc`: 6.05 ms handler including `History.pushState`. |
| 2.193–2.314 s | Urgent JSON GET, request ID 1954210970971: 725 response bytes, about 120 ms total; `requestStart`→`responseStart` 113.9 ms, receiving 0.039 ms. URLs were removed: metadata identification is source/timeline inference, not a recovered URL. |
| 2.315–2.965 s | 650 ms application long task. Initial mount/render occupies about 216 ms through 2.531 s. A nested 44.3 ms layout flush at 2.481–2.525 s includes 19.6 ms styling and 21.3 ms reflow; 8,250 elements traversed, not a transcript-message count. |
| 2.531–2.879 s | Composer `focusin`: 347.7 ms inside that task. 340 of 344 samples contain 1Password functions. |
| 2.879–2.965 s | About 86 ms remaining application work. |
| 2.965–3.029 s | 64 ms long task: 60.6 ms accessibility work, including 42.3 ms `DocAccessibleChild::ShowEvent`. |
| 3.043–3.446 s | Five further application tasks of 61.7, 57.2, 62.3, 67.9 and 64.1 ms: about 313 ms total. |

1Password's sampled chain is `onFocus → _onInputFocus → getFieldDesignation → getCollectionContext → settleAdded → flush → drainPending → processRecords → TreeWalker.nextNode`. Its focus interval accounts for **53.5% of the 650 ms task**. Focus, layout and accessibility subintervals are nested costs, not additive to their enclosing tasks. The entire 650 ms task is not Markdown parsing.

Minified `parse` at script location `23:8681`, under `R9` at `23:13053`, occurs in 113 samples of the first task and 203 samples of the later window. Native `parse JSON` occurs in only two samples across the burst. This is consistent with Markdown processing, but absent source maps prevent definitive function mapping or an exclusive Markdown CPU total.

Click→first application-task end is about **777 ms**; click→last observed burst completion is about **1.26 s**. Neither measures first paint, transcript readiness or live readiness. No screenshots were recorded despite capture being enabled. Stripped URLs and missing application cache marks prevent independently proving the endpoint, selected orb IDs or cache-hit state. This is one switch-shaped field sequence, not a benchmark or extension-disabled comparison.

## Source correlation

- `apps/web/src/lib/orb-load.ts:45–87`: cache hits still await fresh metadata before publishing cached history.
- `apps/web/src/pages/OrbPage.tsx:737–759`: `OrbConversation` is keyed by orb ID, so switching remounts it.
- `apps/web/src/components/HistoryView.tsx:565–574,597–601`: whole-record transforms and `turns.map` render all turns without virtualization.
- `apps/web/src/components/ChatMarkdown.tsx:16–24`: mounted prose passes through `react-markdown` and `remark-gfm` again; the data cache does not retain parsed Markdown or DOM.
- `apps/web/src/components/Composer.tsx:196–205`: arrival focuses the eligible desktop composer, matching the captured extension scan.

Source corroborates the mechanism, not exact attribution of every minified frame. Unlike the September 15 capture (`docs/postmortems/2026-09-15-long-transcript-navigation.md`), this sequence has no large history transfer dominating the delay. Memory caching removes repeat history transfer, not metadata latency, remount/render, layout, accessibility or extension traversal.

## Result (investigation, 2026-10-03)

The selected bare-cache contract already excludes instant rendering (`docs/transcript-cache.md`). This capture demonstrates the remaining costs. An extension-disabled comparison and bounded mounted transcript/virtualization remain proposals, not adopted fixes. Showing read-only cached content before fresh metadata is also unadopted; lifecycle controls would still require fresh authority. No navigation/focus policy changes follow from this investigation. Content-free cache/load, mount, first-paint and live-ready timings would distinguish future outcomes; follow-up is recorded only in the existing **Bound transcript loading** item in `TODO.md`.

## Subsequent decision and release

The investigation describes baseline `e5a2233`. The user subsequently approved nonblocking provisional cached display and automatic last-20/fixed-20 mounting, rejecting a reveal button and virtualization. Fresh metadata retains authority; scroll position, drafts and detail ownership are tested (`docs/transcript-cache.md`, `docs/testing.md`). Source `3032017` was deployed 2026-10-04 through [Deploy 37200573956](https://github.com/schani/pi-orb/actions/runs/37200573956), with all release gates and independent rollout/cleanup checks passing (`docs/deployment.md`). The original field profile remains a diagnosis, not proof of post-release first-paint latency.
