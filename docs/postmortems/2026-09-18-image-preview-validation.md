# Image-preview validation failures (2026-09-18)

## Evidence

The first broad `npm run test:e2e:frontend` log, `/tmp/pi-orb-inline-images/frontend-e2e.log`, reported three identical Chromium composer failures at 1280, 390, and 320px: measured prefix width `15.640625px` versus a reconstructed `15.626465px` (`0.01416px` difference). It also reported an unhandled `apiResponse.json: Response has been disposed` from `e2e/sleep-icon-frontend.e2e.test.ts:52` after the Chromium sleep case passed. Other failures were missing managed Chromium/WebKit executables.

The run was not qualification evidence. Its Vite process observed `styles.css` HMR at 10:00:01, 10:01:06, and 10:01:52 while image-preview work was being edited; the mobile file began at 10:01:57. Tests must run against one stable source tree.

The subsequent stable run, `/tmp/pi-orb-inline-images/final-e2e.log`, passed 103 of 109 frontend tests, including all 14 image-preview cases and the corrected sleep teardown. Its only failures were the same composer case in both engines at all three widths. A text range measured `15.609375px` against Chromium's `15.59375px` track and `15.6025390625px` against WebKit's `15.59375px` track.

## Root causes and corrections

The composer test first inferred the `2ch` grid track by subtracting an unrounded computed `1ch` gap from independently raster-quantized element positions. Chromium 152 consistently differed by less than one device-pixel quantum. Replacing that inference with a text-range-width-to-track-width comparison retained the same invalid assumption: engines quantize CSS `ch` tracks and glyph ranges independently, so a range can exceed its nominal track by a fraction of a pixel without approaching the editor across the explicit `1ch` gap. Product geometry had not moved, and the image-preview selectors did not affect the composer. The regression now measures the prefix grid item, text right edge, and editor left edge directly. It preserves the actual invariants: every mode's glyphs remain before the editor, while track width and editor position remain fixed.

The sleep test closed its page while the orb's two-second metadata poll could still be inside a route handler. Page closure disposed the `route.fetch()` response before the handler read its JSON. Teardown now removes all page routes and waits for active handlers before closing the page. This gives request schedules an explicit owner rather than hiding the rejection.

## Validation rule

Browser qualification requires an unchanged source tree for the whole run. Tests that install asynchronous route handlers must unregister and drain them before closing their page or browser. Layout checks must compare the user-visible edges whose relationship matters; computed CSS units, glyph ranges, and element boxes may be quantized independently.

No deployment was performed. A stable full frontend suite remains required after managed browser installation.
