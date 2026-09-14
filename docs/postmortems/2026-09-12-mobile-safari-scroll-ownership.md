# Phone composer drifts during Safari scrolling and keyboard use

## Evidence (2026-09-12)

The user supplied two physical iPhone Safari screenshots from the Side rail frontend preview. With the editor collapsed, transcript content is visible below the message pad; during keyboard entry, the editor floats above more transcript content and Safari's browser/keyboard chrome. The user reports that momentum scrolling can trigger the displaced layout. This is not the selected composition, where the editor owns the bottom edge and reading ends immediately above it.

The initial implementation passed Chromium phone-width and reduced-height checks. Those checks resized the layout viewport and verified control reachability, but did not reproduce Safari's independently resizing/panning visual viewport or prove a single scroll owner.

## Cause and rejected implementation

The mobile layout retained desktop document scrolling and sticky header/composer positioning. Composer independently calculated `innerHeight - visualViewport.height - visualViewport.offsetTop` and applied it as its sticky bottom offset. This mixed the document scroll range, sticky positioning, and visual viewport coordinates. Moving a sticky child above the document bottom still allows document content beneath it; mobile browser UI, keyboard panning and momentum scrolling expose that composition defect. The screenshots establish the broken result, not the precise sequence of Safari compositor events.

Increasing the bottom offset, adding a keyboard timeout, and disabling momentum scrolling are not the correction. The obsolete per-composer keyboard offset is removed.

## Correction

At phone widths only, the app containing an orb owns one fixed visual-viewport-sized box. Its top and height follow visual viewport scroll/resize events. Body/document scrolling is locked for this route, with no global mutation left behind on route/breakpoint exit. The session ribbon, header and composer participate in normal flex layout inside that box; only the middle transcript region scrolls. Overscroll is contained in that region. There is no sticky mobile child or independent keyboard inset.

The same reading region contains upload progress, lifecycle notices and history. Header actions and composer expansion reduce its available height rather than overlapping it. Desktop's wrapper uses `display: contents`; desktop document scrolling, header, composer and index geometry are preserved.

Tail-following reads the phone scroll region instead of the window. A resize observer follows viewport/composer height changes only while already pinned; readers away from the tail retain their position. Native pinch zoom keeps the existing layout instead of causing a second reflow; listeners and CSS variables are removed when leaving phone layout.

## Follow-up: missing paint after scrolling (2026-09-13)

The user's next iPhone screenshot showed a large blank region below the header while the lower transcript and composer remained visible. The fixed-viewport correction alone did not establish working physical Safari scrolling. The exact blank-paint artifact has not been reproduced in Linux Playwright WebKit; it must not be described as a confirmed WebKit root cause based only on that screenshot.

Inspection found a concrete scroll-ownership violation: the phone path assigned `scroller.scrollTop` on **every OrbConversation render** while pinned, including polling/age updates that changed no transcript geometry. Assigning the same offset still invokes the browser's programmatic-scroll machinery. A regression instruments the native property setter and forces a metadata poll; before correction it observed repeated writes (1, then up to 9 during the failed assertion), with no content/viewport growth. This reproduces unnecessary interference with the native scroll layer, not the exact physical-device raster failure.

**Corrected invariant:** phone auto-scroll is driven only by ResizeObserver measurements of the reading viewport and its content box. It never writes an already-satisfied target (within one CSS pixel), and does not run from the generic render effect. Pointer-down/wheel intent releases tail pinning before delayed scroll events; actual scroll position can reestablish it. An observed content wrapper captures live text, disclosures and notices as well as viewport/composer resizing. Desktop retains its previous document-scroll effect. GPU promotion, forced repaint loops and momentum-disabling workarounds were not added without a reproducible need.

Validation now includes WebKit as well as Chromium. The metadata-poll setter test proves zero writes after correction in both engines. A separate phone-width native wheel round trip compares transcript PNG bytes before/after returning to the top; pixels match in both engines and on the shared preview. Playwright's **mobile WebKit** rejects wheel input (`Mouse wheel is not supported in mobile WebKit`), so the raster test explicitly uses WebKit's desktop input backend at a phone-sized viewport, while the other phone tests use mobile emulation. Neither is physical iPhone inertia or Safari chrome/keyboard validation. The device confirmation remains in `TODO.md`.

## Validation and limits

The new browser regression injects a controllable visual viewport while leaving the layout viewport at 844px. It interleaves reader scrolls with visual-height and offset changes, checking that header bottom equals reading top, reading bottom equals composer top, composer bottom equals visual viewport bottom, and window scroll stays zero. It also checks pinned-tail resize behavior, away-from-tail position retention, native-zoom non-reflow, draft preservation and desktop restoration. This test fails the old layout's structural invariant even without recreating physical inertia.

After the follow-up, 206 web unit tests, 34 frontend Chromium tests and seven focused WebKit phone tests pass, as do web and E2E typechecking. The actual shared frontend was smoke-tested at a 440px viewport: composer bottom 440, reading bottom and composer top both 351, document scroll zero, successful touch send, no browser script errors.

**User retest (2026-09-13):** after removal of the unrelated scroll writes, the user reported “Looks pretty good!” This is positive field feedback on the updated iPhone preview, not an exhaustive sign-off on rotation, long drafts, or Android behavior. Controlled geometry tests are not a substitute for that wider physical-device matrix. Remaining device checks are tracked in `TODO.md`; the current layout contract is in `docs/web-ui.md`.
