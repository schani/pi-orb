# Terminal resize focus and partial scrollback rows (2026-09-12)

## Report and scope

The shared frontend preview showed a thick black bottom edge after resizing, a hollow terminal cursor, and a cut-off row at the top after output filled scrollback. These were browser presentation defects; terminal bytes and persisted conversation history were unaffected.

## Causes and reproduction

- The bottom-edge pointer handler explicitly focused its 8px hit target. The application's global `:focus-visible` rule filled focused elements black. The local outline override did not reset that background, so the whole hit target looked like a permanently thick border. Focus also left the shell, producing its hollow cursor.
- Vertical padding lived inside the scrolling emulator. Thirty Enter presses against the fixture reproduced `scrollTop: 400`, a 266px viewport, `padding: 13px 15px`, and the first intersecting 20px row starting at **-7px**. A whole-row scroll offset and a whole-row content height were insufficient: scrolling also displaced the padding, allowing the previous row's trailing 13px to show at the top.

## Correction

Pointer down prevents the browser's default focus change but no longer calls focus. Pointer capture controls only the drag lifetime. The hit target remains transparent even for deliberate keyboard focus, and its focus outline never changes border thickness. Existing row-step keyboard resizing remains available.

Vertical padding belongs to the non-scrolling outer frame. The emulator viewport has zero vertical padding and an exact multiple of the row height; the surrounding body clips rather than becoming another scrolling surface. After the same output sequence, the viewport was 240px high, `scrollTop` was 400, and the first visible row began at **0px**. CSS row snap points settle native scrollback gestures on complete rows. Very short frame bounds also round visible content down to complete rows rather than allocating a fractional bottom row.

The resize preview still changes by whole rows only while dragging. One PTY resize commits on release; cancellation restores the committed height. Changing that transport policy was unnecessary to correct focus and padding.

## Verification and resulting rule

Browser tests fill scrollback, inspect the actual first and last visible row rectangles, wait for a native wheel `scrollend`, and check boundaries again after drag and viewport resize. They assert that drag leaves the active element unchanged for both terminal and composer focus, including cancellation, and that the border remains 1px with a transparent hit target even after keyboard resizing.

Checking only `scrollTop % rowHeight` or `(height - padding) % rowHeight` was an inadequate regression. Test the visible row boundaries themselves. The current contract lives in `docs/terminal.md`.
