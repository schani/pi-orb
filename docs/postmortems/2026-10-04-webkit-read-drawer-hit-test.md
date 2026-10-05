# WebKit read-drawer hit test — 2026-10-04

## Evidence

Original full process E2E log: `/tmp/remove-composer-validation/e2e.log`, lines 414–448. WebKit case `uses call arguments only when a completed read's result has no displayable body` failed at `e2e/tool-images-frontend.e2e.test.ts:351:48`: `normal.locator(":scope > summary").click()` timed out after 30,000 ms.

The locator resolved the `docs/web-ui.md` read-call summary within the `HistoryView.tsx` / `docs/web-ui.md` category. Playwright reported visible, enabled, stable and completed scrolling, but `<p>Before receipt.</p>` from the `response-markdown` subtree intercepted pointer events across 59 attempts (2 + 2 + 55). The click was never admitted; this is not a fallback-result rendering failure or a `waitForResponse` race.

Small sanitized summary: `test-failures/2026-10-04-webkit-read-drawer-hit-test.json` (**NON-REPLAYABLE**, not a determined trace). On the investigation compute, the original `/tmp` log is absent; the summary is preserved unchanged.

## Bounded investigation — 2026-10-04

`e2e/testkit/read-drawer-hit-observer.ts` records content-free node/parent identities, ancestor geometry and scroll positions, disclosure state, viewport-center hit stacks, actual admitted pointer coordinates, native pointerdown/up/click/toggle order, detail requests/responses and cache admission diagnostics. Failure capture is automatic; `PI_ORB_READ_HIT_EVIDENCE=1` also preserves passing observations as gzipped JSON.

The fallback test retains the original normal-first order and explores explicit response gates: empty result held, fallback arguments held, and arguments released immediately before the normal summary's native locator click. The last gate controls response release, **not** its rendering time relative to pointer admission. Assertions and ordinary locator clicks remain intact; no forced clicks, programmatic disclosure opening, sleeps or timeout changes.

Evidence inventory and limitations: `test-failures/2026-10-04-read-drawer-exploration.json`. Its 20 `.json.gz` artifacts contain raw observations, readable with `gzip -dc <path>`. All are **NON-REPLAYABLE**.

- Initial instrumented baseline: Chromium/WebKit passed once (2 cases). A final two-case observer smoke test verified gzip output and hit rectangles; it is not qualification.
- Current working tree: complete owned file passed 24 cases across both engines, including all four schedules.
- Isolated `git archive 116eb54` restored the old UI, protocol and fixture; the old test has the failing click at line 351. With only the instrumented test/helper substituted, all eight schedule/engine combinations passed. This reconstructs code, not the historical environment or schedule.

In the initial WebKit observation, the category summary moved from y=-107 through y=-1544 to y=407 while the transcript scrolled; Chromium also moved. In the current release-at-click observation, fallback rendering moved the normal summary from y=469 to y=519 before pointerdown. Its actual native pointerdown/up hit the summary's code child, followed by a disclosure toggle. Neither observation reproduced the paragraph interceptor; neither establishes scroll anchoring or unchanged drawer code as the cause.

Probes read layout/style/hit testing and therefore perturb scheduling. Sampled centers are diagnostic candidates, not Playwright's internal retry coordinates. Actual pointer coordinates exist only for admitted clicks. Cache diagnostics expose record/detail identity and admission outcome, not private owner identity. No failed causal schedule was recovered, so no claimed failing regression or production fix was added. Preview ports 7100/5173 remained untouched; tests used their own ephemeral listeners/caches and the process backend.

## Probe-free exploration — 2026-10-05

The original normal-first click precedes either read child's opening. The old `CallBody` mounts only when the category **and** that child are open; result/input loading cannot explain this pre-admission failure. The earlier fallback gates explored other schedules, not the original trigger.

Sixteen new cases ran once, without the continuous geometry observer:

- Ten Chromium/WebKit cases held fonts or images through the normal click, released them after category admission, or used no resource gate. Native event logging read identities/coordinates, not layout. All normal clicks admitted. WebKit had one transient **category** interception by `The activity rail is implemented and verified.` while images remained held; Playwright recovered on its next attempt. Chromium also had transient category interceptions. This is not the original persistent normal-summary interception.
- Two cases restored the original history fetch/fulfill and empty-result route. Getter-free `scrollTop` setter logging and Playwright protocol logging captured native coordinates without a layout observer. Both admitted the normal-first click.
- Four cases waited for fonts and positioned the closed category at y=497, then compared no post-expansion probe against one geometry/hit read after expansion. Both WebKit cases admitted category pointerdown at (758,507) and normal pointerdown at (769,549), with no programmatic scroll write between them. Neither failed; this does not show that probing heals the defect. Image decoding remained uncontrolled.

Inventory: `test-failures/2026-10-05-webkit-cause-exploration.json`. Compressed observations, source snapshots and relevant API/protocol excerpts are under `test-failures/2026-10-05-webkit-cause/`; full first-run logs remain in `.context/webkit-cause/`. All are **NON-REPLAYABLE**. Exploratory tests are not part of regular qualification. No production change or deployment.

A useful next discrimination is the rejected coordinate versus the following paragraph's **current** rectangle and its pre-expansion rectangle. Capture the coordinate from Playwright protocol logging; read geometry only after the first interception. A point inside the current paragraph indicates a real geometry/scroll race; a point only inside its pre-expansion rectangle supports stale disclosure hit testing. That post-interception read may heal subsequent retries, so preserve the first evidence before probing. This remains a hypothesis test, not a root-cause finding.

## Synchronized point measurement — 2026-10-05

Main-world `addInitScript` prototype wrappers do not observe Playwright's utility-world `expectHitTarget`. A temporary local Playwright injected-script wrapper instead called `root.elementsFromPoint` **first**, preserved its returned list, and read geometry only on its first wrong response-paragraph result. It recorded the exact rejected point, current target/paragraph rectangles, disclosure/scroll state and a separate `elementFromPoint` result. These later reads can heal retries; they cannot change the captured first returned list. The dependency bundle was restored byte-for-byte afterwards.

**Captured:** current-tree image-held **category** click at (758,417), target rectangle y=393–413, intercepted paragraph `The activity rail is implemented and verified.` at y=417–437. The current paragraph rectangle contains the attempted point; the separate point query still returned that paragraph. This particular transient was real geometry displacement, not stale paragraph hit geometry. No displacement magnitude is inferred without the original content quad. It recovered on retry; it is not the original persistent **normal-summary** failure. Getter-free scroll setter events show tail writes before admission, not a write between the eventual category and normal pointerdowns.

The old read summaries are already mounted while their category is closed; only `CallBody` is conditional. A static old-CSS reduction reproduces category y=497 / height=66, normal summary y=539 / height=20 and expanded `Before receipt.` y=587–607. Its pre-expansion paragraph would occupy y=541–561, containing the normal center y=549. Five distinct static schedules—pre-mounted, hidden-subtree mutation, toggle-mounted, and native-wheel versions of the first two—admitted native clicks. This supports the candidate's geometry, not its engine failure or exclusion.

**Competing 46px transition:** the fixture user attachment above the read group is 160×60. A 20px loading span becoming a 62px bordered image with 4px top margin also adds 46px. Earlier image-resource gates held blob loading, not the API fetch/source admission; their label does not establish settled attachment geometry. Three old-baseline attachment-fetch gates and two attachment-blob gates controlled admission/decoding around category and normal clicks; all admitted the normal click. Release order is controlled, not the render/compositor interleaving.

The additional exploration contains 16 successful scenarios, including the measured transient, not release qualification. Two harness defects were preserved separately: a partial old archive omitted `tsconfig.base.json` and failed before app boot; an exact wheel-delta offset assumption timed out before the category click. Restoring the old base config corrected the former; a distinct native-wheel-to-top boundary replaced the latter assumption. No timeout, native-click assertion or pointer result was weakened.

Inventory and raw first-run logs/observations/source snapshots: `test-failures/2026-10-05-webkit-point-cause-exploration.json`, `test-failures/2026-10-05-webkit-point-cause/`. All are **NON-REPLAYABLE**. The utility-world wrapper is validated by the real captured interception, but no original normal-summary interception was recovered. No production fix was added.

## One-shot expansion resize schedule — 2026-10-05

The old app's actual parent ResizeObserver was held once for the category's measured +46px expansion, then released at Playwright's before-hit-target hook **after** normal coordinates were selected. Images/fonts were already loaded. Setup used a fixed desktop viewport sized to give the closed category y=497 and 24px bottom slack; it did not manufacture a scroll or repeated callback. Native category pointerup can repin within the 48px slack before disclosure expansion.

**Causal result:** the normal summary's raw content quad was y=539–559, selecting (769.79,549). Releasing the single real parent callback wrote transcript scrollTop=70: 24px existing slack plus 46px expansion. Its first original point result hit a subagent summary. The synchronized snapshot showed the normal summary now y=469–489, category open at y=427 / height=66, and `Before receipt.` y=517–537. The raw quad was selected before real movement, not evidence of stale quad caching. Native retry scrolling returned scrollTop to 0, reacquired a fresh quad at y=539–559 and admitted the next attempt. The callback was held/released exactly once; no feedback loop was manufactured.

The first run established the wrong-target/retry sequence. One further measurement widened the first-wrong-point observer from response paragraphs to any wrong **normal** hit, capturing the subagent interceptor's synchronized geometry while preserving the original point result. Both first logs are retained. The observed one-shot schedule explains a normal-summary transient but is **insufficient for the original 59 interceptions**; neither repeated mismatch nor stale fresh quads was observed after callback drain. No production fix follows from this result alone.

Raw logs, actual RO/scroll/pointer timeline, quads, observations and source snapshots: `test-failures/2026-10-05-webkit-one-shot/`. All are **NON-REPLAYABLE**. The temporary dependency hooks were restored byte-for-byte; exploratory tests were removed. Preview processes remained untouched.

## Zero-slack exact interceptor — 2026-10-05

One changed schedule set pre-expansion bottom slack to **0**, with the actual old app, loaded media/fonts and closed category still at y=497. The fixed desktop viewport was 1280×2941; this is a controlled causal construction, not the historical 1280×900 environment. The parent expansion callback was held/released once after normal raw quad y=539–559 selected (769.79,549).

**Exact interceptor reproduced:** the parent callback wrote scrollTop=46. The first original point result returned `Before receipt.`; its current client rectangle was y=541–561, containing the attempted point. The normal summary's current rectangle was y=493–513. Ordinary Playwright retry scrolling reacquired raw quad y=539–559 and admitted its next attempt. Thus the historical paragraph identity and the apparent collapsed-layout 46px offset have a viable **real-movement** explanation; they do not establish stale disclosure hit testing.

Getter-free observer IDs/generations, native content rectangles, callback entry/exit and writer attribution show one parent and one HistoryTail expansion delivery (generation 6). Across both normal attempts there was one parent programmatic scroll write, two native scroll events and **no new resize delivery**. No natural resize feedback or persistent raw-quad mismatch was observed. Native ResizeObserverSize objects serialized without their axes; content rectangles and target identities are retained, so border-box dimensions are unavailable.

The actual variant ran once. An earlier temporary bundle patch had an escaped-newline syntax error before any test executed; its first log is retained separately. Evidence: `test-failures/2026-10-05-webkit-zero-slack.json`, `test-failures/2026-10-05-webkit-zero-slack/`. All are **NON-REPLAYABLE**. The bundle was restored byte-for-byte; no production change, push or deployment. The original 59-attempt persistence remains unproved.

## Read-fallback isolation — 2026-10-05

**Decision:** isolate the semantic test, not change production scrolling. Its four schedules now own a stopped-orb history: one user root, two read calls and their causally chained completed results. An empty result requires arguments; a short displayable result must not fetch arguments. The shared all-tool/media fixture remains unchanged for other cases. Projection and detail responses use `projectFixtureHistory`; response gates use route fallback so that helper retains ownership.

At the unchanged 1280×900 viewport, setup and disclosure/loading/completed boundaries assert no transcript overflow and scrollTop=0. Fonts settle once after the category mounts. Native locator clicks, loading assertions, result/input request counts and output assertions remain. There are no continuous geometry/hit probes; native event/request evidence is saved on failure, with a final scroll snapshot. No runtime/model calls or production edits.

**Tests first:** the initial invariant accidentally measured the content node and passed; changing it to the actual transcript scroller made the shared fixture fail in both engines (overflow=true; scrollTop 664/348). After isolation, all semantic checks passed, but a new socket counter incorrectly included Vite HMR. Filtering only the orb live socket fixed that deterministic harness defect. The complete file then passed 24/24 Chromium/WebKit cases; E2E typechecking, scoped Biome and diff checks passed. No Docker/full-release suite ran.

**One-shot adversarial evidence:** at 1280×900, the minimal fixture's actual parent ResizeObserver +46px expansion delivery was held once and released by the temporary Playwright hook after normal coordinates were selected. Both original point queries admitted the summary; exactly one native pointerdown/up and disclosure toggle followed, with no normal-phase scrollTop write. The real callback entered/exited once before pointerdown. Bounded content removes the positive tail offset that displaced the large fixture's target.

The exploratory harness failed at `proof.ts:185`: `firstHits` counted every normal-phase point query but expected one. Playwright performs a preflight query and a native-event interceptor query; both admitted. This was a measurement defect, not two click attempts. The failed log and timeline remain byte-identical.

**Corrected proof:** after inspecting those two call sites, temporary instrumentation labeled their stages and recorded the actual raw quad, selected point and before-hit hook. The repaired proof ran once and passed: one quad acquisition/selected point/hook, one native pointerdown/up/toggle, and one held/released +46px parent delivery. Timeline assertions place selection before release, the real callback's entry/exit before the original preflight decision, and that decision before pointerdown. Both stage-labeled queries admitted. The proof continued through visible normal output, empty-result arguments fallback, exactly three detail requests (normal result, empty result, empty-call arguments; no normal-call arguments), and final transcript bounds `{ overflow: false, scrollTop: 0 }`.

The dependency bundle was restored byte-for-byte (SHA-256 `549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171`) before other qualification could begin. The temporary test was removed; no dependency hook remains in the regular suite.

Logs, source and evidence: `.context/read-fallback-isolation/`, including `red-scroll-container.log`, `proof/FIRST-FAILURE.json`, unchanged `proof.log`, `proof-accounting-fixed.log`, `proof-accounting-fixed/outcome.json`, `evidence.json` and `focused-fixed.log`. All browser observations are **NON-REPLAYABLE**. Preview ports 7100/5173 remained untouched. No commit, push or deployment.

## Limits and disposition

The isolated semantic test no longer depends on media admission or positive tail scrolling. The historical **59-attempt persistence remains unproved**; the one-shot large-fixture reproduction recovered on retry. Isolation is not a production hit-testing fix or proof that arbitrary overflowing transcripts are unaffected.

Final process-backed frontend qualification passed in one continuous run: **30 files / 256 tests**, including all **24 Chromium/WebKit image cases**; E2E typechecking, repository lint (no errors) and diff checks passed. Evidence: `.context/read-fallback-isolation/full-frontend.summary.md` and its linked logs. This qualifies the test-only change before the later rebase, not all 42 browser files or the Docker/full-release suite. After rebasing onto the production scroll changes, the focused 24 image cases and E2E typecheck passed.

**User disposition (2026-10-05):** flaky UI tests must be fixed and validated; deep historical forensics are optional once corrective stabilization is evidenced. The bounded fixture and adversarial proof satisfy that correction here. The original 59-interception cause remains unproved, with evidence preserved, but no longer blocks release under this explicit exception. A passing rerun alone would not suffice. Release qualification remains separate; non-UI and DST requirements are unchanged (`AGENTS.md`, `docs/testing.md`).
