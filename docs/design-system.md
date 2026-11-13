# Design system

**Signal / Boards** is the visual system of `apps/web`. The Paper file [pi-orb Design System](https://app.paper.design/file/01M6VFPKDT6AWJ8M92A517NQGH) draws it (Foundations, Components, Screens, Resolutions, Dark); this doc is its written spec. Both describe the same system and change together. `apps/web/src/styles.contract.test.ts` holds the code to the scales. Behaviour stays with its feature (`docs/web-ui.md` and the feature docs).

## Principles

- White paper, black ink, rules instead of boxes. The dashboard says what every orb is doing at a glance; the transcript is for reading. Rejected: the serif "Reading Room" design (warm palette, turn gutter, rounded panels), made for introducing a product to a stranger.
- No app header or brand line. No placeholders, speaker gutters or decorative prefixes.
- One banner, one tag, one paper tooltip, one close button.
- Shape carries state; colour signals. Signal hues sit on paper only.

## Tokens

### Colour

Literals live only in the `:root` block of `apps/web/src/styles.css` and its dark block. Vega takes `var(--…)` strings (`apps/web/src/lib/chart-spec.ts`); Mermaid takes resolved values from `apps/web/src/lib/design-tokens.ts`.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--w` | `#fff` | `#000` | paper |
| `--k` | `#000` | `#fff` | ink |
| `--g1` | `#f2f2f2` | `#1a1a1a` | fills, insets |
| `--g1x` | `#ddd` | `#333` | hover on fills, picked dot, chart grid |
| `--g2` | `#999` | `#666` | hairlines, disabled, selection |
| `--g3` | `#555` | `#aaa` | secondary text, the one inactive grey (`#777` failed AA at 4.48:1) |
| `--ok` | `#1a7e37` | `#46bd68` | alive now |
| `--warn` | `#966100` | `#e3a33b` | in transition, restart |
| `--bad` | `#b42318` | `#ff7a6b` | the one red: gone wrong, every delete |
| `--bad-bg` | `#fdecea` | `#3a1612` | pale ground under `--bad` |
| `--done` | `#8250df` | `#ab7df8` | GitHub merged or completed |
| `--you` / `--on-you` | `--k` / `--w` | `#2b2b2b` / `--k` | user turn |
| `--alert` / `--on-alert` | `--bad` / `--w` | `#b42318` / `--k` | alert band |
| `--tile-gray` | `#555` | `#555` | grey state tiles |
| `--image-backing` | `#fff` | `#fff` | behind images |
| `--scrim` | black 35% | black 60% | behind dialogs and Find |
| `--lightbox` | black 72% | black 72% | behind image and diagram viewers |
| `--veil` | paper 75% | paper 75% | drop wash |
| `--chart-1…6` | `#2a78d6 #eb6834 #4a3aa7 #1baf7a #c2418a #7a5c00` | `#5b9eea #f08050 #a594f0 #2fc08e #e06bab #c9a227` | chart series 4–6 |

Each lifecycle state owns a hue, used wherever that state appears: `--st-busy`, `--st-running` (`--ok`); `--st-transitional`, `--st-archiving` (`--warn`); `--st-stopped`, `--st-sleeping`, `--st-archived` (`--g3`); `--st-failed`, `--st-deleting` (`--bad`). Failure text, failed rows and errors are `--bad`.

### Type

- `--text` is Iosevka Etoile (quasi-proportional) for UI, transcript prose and every composer mode. `--mono` is JetBrains Mono for inline code, code blocks, tool output, the Bit register, tooltips, charts and terminal cells. Both enable `calt` ligatures and tabular numerals.
- Regular, bold and italic WOFF2 subsets (Latin/ASCII plus UI symbols) are served from `apps/web/public/fonts` with OFL licenses and a source/SHA-256 manifest. Subset family names stay renamed as the licenses require. Other glyphs use fallback fonts; bold italic is synthesized. Versions and archive digests: `docs/dependency-audit.md`.
- Scale (size/line): micro 11/16 (mono: charts, tooltips, ranks), base 13/20 everywhere, controls 13/18, title 18/24, metric 26/32. Weights 400 and 700.
- Headings, including Markdown `h1`–`h6`, are uppercase bold at body size with `letter-spacing: .08em`; metric labels are caps. Only project names and the New project heading rank by size (title). Device codes track at `.16em`.
- Editable inputs, textareas and selects use 16px at ≤600px or when any pointer is coarse, so Safari does not zoom on focus. The transcript stays 13px.

### Space and size

| | |
| --- | --- |
| Space scale | 2 4 6 8 12 16 20 24; page gutter 12, inner gutter 8 |
| Heights | row 20 (`--row`), bar 24 (`--bar`), dialog head 32, touch 44 |
| Widths | index 236, board column 316, command picker 420, dialog 560, Find 640 |
| Breakpoints | phone ≤600, stack ≤900 |
| Radius | 0; state tiles 2; dots round |
| Opacity | blink 15%; scrim, lightbox and veil above |

Phone and coarse-pointer targets are 44px.

## Dark mode

The theme follows `prefers-color-scheme`, live, with no setting and nothing stored; a stored toggle was rejected. Dark redefines the `:root` tokens in one media block in `styles.css`. Paper and ink are absolutes, `#000` and `#fff` (`#111`/`#f0f0f0` rejected; it stays a two-token change if `#000` smears on a phone); greys, signal and chart hues are restated to keep AA.

Five things are not a flip, drawn on the Paper file's Dark page against what was rejected:

- The user turn fills `--you #2b2b2b` with `--on-you` text; a full-width white block outshone the transcript.
- `--alert` keeps the light red `#b42318` with white text; the dark `--bad` is for text and small marks and glared at full width.
- State tiles are the favicon SVGs on constant fills (`--tile-gray` for grey), so a mark means one thing in both themes. The grey tile is 2.8:1 on black; its white glyph carries it.
- Screenshots and attachments sit on `--image-backing`, since black marks on a transparent background vanish on black paper.
- `--scrim` stays black, at 60%; an ink scrim lit the page up behind dialogs.

Charts need no re-render: Vega writes `var(--…)` colours into SVG attributes. Mermaid re-renders on a scheme change (`useColorScheme`). Browser chrome follows through the pre-paint `color-scheme` meta, per-scheme `theme-color` metas and the status-bar band (`docs/web-ui.md`), which turns black. `manifest.webmanifest` has no per-scheme colours, so an installed app's launch splash stays white.

## Geometry and states

- 1px ink rules, `--g2` hairlines, zero radius, no shadows, no gradients. The transcript has no max-width.
- **Hover.** Buttons and links invert; rows take `--g1` on paper and `--g1x` on fills.
- **Focus** is inversion (ink ground, paper text), not a tint; the current row is inverted too. Focus inversion outranks every state hue and hover through one `!important` rule; only danger, primary and ring targets override it. An already-inverted control (current index row, selected tab, period, search result or command, pressed icon, link or table in a user turn) steps from ink to `--g3` on focus. Rejected: an inset paper ring (invisible on paper) and an outer ink ring (clipped by the index edges and header bar).
- Images and plots cannot invert: they get a 2px ink ring. Fields get crop marks (Controls).
- **Selection** is inversion only. The global `::selection` is ink on `--g2`, readable on paper and inverted surfaces; no modal-specific overrides.
- **Disabled** is `--g2` text and border; a disabled text action's rule turns dotted.
- **Links** have a 1px underline under their text only, never the cell, and invert on hover, past any state grey.
- Orb names on the dashboard and index use regular weight in every state.
- **Motion.** Only two things move: running dots blink (1s, two steps, to 15%) and the Bit register steps. Everything else, including the terminal shade, opens and closes instantly.

## State tiles

Ten 16×16 SVGs in `apps/web/public/favicons/` are the only state geometry for favicons, rows, the index, the header and Find (`StateTile`). Shape alone carries meaning; names follow the files.

| Tile | Glyph | Fill |
| --- | --- | --- |
| `running` | ring | green |
| `busy` | three dots | green |
| `transitional` | hourglass | ochre |
| `archiving` | arrow down | ochre |
| `stopped` | minus | grey |
| `sleeping` | slender crescent (`stopped` with `sleepUntil` only) | grey |
| `archived` | inset box | grey |
| `failed` | cross | red |
| `deleting` | bin | red |
| `neutral` | π | grey |

Glyphs are white 1.5px strokes with round caps on a 2px-radius tile. Tiles keep their fills on inverted rows and have an accessible name and title unless adjacent text names the state. An unread alert replaces the tile with a red flag (`alert.svg`, no `!`).

## Icons

- One inline sprite (`apps/web/src/components/Icons.tsx`, rendered once by the app shell) draws every icon on one 16px grid with square-ended 1.5px strokes: plus, pen, archive, bin, x, copy, gear, upload (tray arrow), share (three connected nodes), start and stop (solid play and square), terminal (`>_`), fold, send, back, more, trend, source, expand, refresh, key, and the link kinds pull (branch merge), issue (dotted ring) and run (ringed play). Pi and Claude creation icons are `HarnessIcon.tsx`.
- Icon-only buttons are 20px with `aria-label` and `title`; icon buttons never carry text; text actions never carry icons. A pressed icon is inverted.
- Delete is the "crisp utility" bin. **Every delete is red** and inverts to a red ground on hover. Stop stays neutral, never red.
- Markdown code blocks, responses and device codes share the copy icon. Copy feedback is colour plus the accessible label, never visible text.
- The home-screen icon (`apps/web/app-icon.svg`) is a black π on full-bleed white; iOS masking framed a grey tile.

## Components

### Controls

- **Button:** 1px ink border, 8px side padding, 18px line. **Primary** (Create project) is inverted and flips to paper on hover, focus and disabled. **Danger** is red with a red border.
- **Text action:** the word over a `--g2` rule, `--g3` text, no box.
- **Segments and tabs:** text buttons in a row; the selected one is inverted.
- **Field:** production inputs and textareas show no placeholder; labels are the accessible names. Focus draws four 11px ink crop-mark corners 3px outside the field (3px inside the padding for the full-bleed instruction editors) without changing border, size or padding (`TextFieldFrame`). Rejected: paper-on-ink focus (replaced the writing surface) and a writing-edge rail (formed a double edge).
- **Composer:** full-bleed and opaque; the bold mode prefix in a reserved `2ch` column with a `1ch` gap; the textarea at least four rows; the abort `x` at the right. Phone: folded, a 44px row; open, 88px high with 16/20 text beside a 44px rail with Fold above Send.

### Feedback

- **Banner:** 1px ink border, 8px side padding; the error banner is `--bad` on `--bad-bg` with a red border.
- **Session ribbon:** a 24px bar, `--bad` on `--bad-bg` over a red rule; its button inverts to red.
- **Notices** (lifecycle, authentication, errors) span the transcript width and wrap long text.
- **Alert band:** `--on-alert` text on `--alert`, 8px 12px padding, wrapping anywhere. Alternatives: `design-prototypes/orb-alerts.html`.
- **Tag:** 1px `currentcolor` border, 6px side padding, 16px line.
- **Tooltip:** paper, 1px ink border, mono 11/16, one line with ellipsis. The activity-strip and waterfall tooltips are this tooltip; failure, running and restart labels take `--bad`, `--ok`, `--warn`.
- **Bit register** (`BitRegister.tsx`), the live-work mark: paper 13/16 mono digits in an ink `calc(3ch + 6px)` × 16px tile cycling the Gray code `001 → 011 → 010 → 110 → 111 → 101 → 100 → 000` at 400ms per frame via one CSS-stepped strip. Reduced motion shows `001`. It sits at the orb turn's 12px inset and never shifts between phases. Decoration, never a progress or work counter.
- **Drop target:** a dashed 1px boundary 8px inside the receiving surface, a `--veil` wash and a centred paper-backed caption.

### Board and index

- **Board:** fills the viewport between two 24px bars. One background rule per masonry column runs from strip to footer.
- **Totals strip:** four cells split by 1px rules, each a bold number and an uppercase grey label; icon-only Usage (trend) and Settings (gear) at the right. At ≤600px two rows, with the icons spanning both.
- **Project header** (`ProjectHeader`, shared by board and index): black-ruled, title-size name, then right-aligned Pi, Claude, gear and red bin; on the index these are contiguous 24px cells, the bin flush with the index's right border. A project box closes with a black rule; a deleting project is greyed; errors are red lines. **New project** has a dashed left rule.
- **Orb entry:** two 20px lines behind a 2px left border in the state hue (dotted while deleting), 4px padding above and below: (1) state tile, vertically centred, and the 13px name, grey when stopped or archived, truncated; (2) age, with archive and red delete icons right-aligned. On phones archive and delete sit 44px apart with 44px tap areas overflowing the meta row, so rows keep their height and a long title can run under them. Rejected: 20px targets (too small) and 44px rows (13 → 10 orbs on an iPhone 14 dashboard). Error and blocker lines are red and grey.
- **Archive:** a `--g1` disclosure footer; its rows hover `--g1x`.
- **Nesting:** a thin connector; indentation 18px per level, saturating at 40% of the width.
- **Index:** 236px with a black right rule. First row: a 24px `PI-ORB` home link with the neutral tile, under a black rule. Rows are `tile | name | age` with `--g1` hover and the current orb inverted.

### Header stack

- **Orb header:** one 24px line over a black rule: `name · rename · share | state tile + word · start/stop | model | thinking/effort | terminal · upload | archive | delete`. On desktop full-height 1px rules divide the cells, Start/Stop sitting beside the state. The name cell flexes and truncates; the settings cells take at most 40% and the model name ellipsizes. Action icons are 20px with 8px spacing. Phone: actions fold behind `more` into a second row.
- **Rails** (Subagents, Shell, Links, Files) are activity-rail summaries: label left, counts or dots right-aligned. Expanded, flat rows in a bounded scroll area.
- **Links:** summary `links` plus one dot per link, right-aligned. Dots use the activity-strip states: red failed, blinking green running, black passed, grey pending or without checks. Kind icons take GitHub's state colours: open, approved and passed `--ok`; draft `--g3`; merged and completed issues `--done`; closed and failed `--bad`; running and queued `--warn`. The roster scrolls past 40dvh.
- **CI waterfall:** check name (a link), status dot, bars on one track from the first queue time to the last finish (now while anything runs), and run duration. A bar is the run: black passed, red failed, green running; a pending job is an outlined bar from when it became ready until now. Time waiting on other jobs is not drawn. Tooltip `name · result · waiting for a runner · ran`. Job steps are nested rows. Rows are mono 11 on 20px; a focused row takes the plot ring. Below 900px the bars hide, below 600px the duration. Alternatives: `design-prototypes/orb-links.html`, `design-prototypes/orb-links-duration.html` (D6).
- **Terminal shade:** opaque, full width, with a complete 1px frame whose top and left rules overlap the header and index rules by one pixel (`left: -1px; width: calc(100% + 1px)`), right edge aligned to the header. No title bar, status word, healthy-state controls, emulator border, radius or shadow.

### Transcript

- **User turn:** a full-width `--you` band with `--on-you` normal-weight prose, 8px 12px padding. Inline and fenced code in it get a paper surface; failed-message diagnostics are red on a small paper surface. A queued message is the same band behind a dotted 2px `--on-you` left rule with its status word.
- **Orb turn:** paper. Rejected: other speaker treatments (inline stamps, rule captions, edge notches, `>`/`<` prefixes).
- **Activity rail:** one thin grey rail through the chevrons of a run of rows, with equal space above and below. A row (`ActivityRailRow`) is 20px: `▸`/`▾` chevron on a 12px paper mask, `label · headline` clipped to one line, metric at the right edge. No row outlines. Expanded bodies use the full turn width on `--g1` with a content inset clear of the rail; nested output keeps its own border.
- **Tool rows:** each expanded tool row owns its state: headline, dot and status green while running and red on failure; completed rows ink with grey status. A failed group never tints its children. Commands render flat: `run` prefix, bold command, output, then green `✓ completed` or red `✕ failed`. Bash and code-mode headers show code in mono.
- **Diff counts:** edits show `+added −removed` as the metric.
- **Activity strip:** one dot per step in a gapless 12×20px cell, count as metric. Dots: thinking small grey (3px), success ink, receipt grey, failure red, running a blinking green ring, restart a `--warn` refresh glyph in the 6px dot box. Excess dots collapse oldest-first into `+N`. The body is an indented `--g1` band of borderless rows.
- **Code:** inline code and fences share the `--g1` ground; fences keep a 1px ink border and have no header or language label. Each fence has a corner copy icon with reserved space beside the scrollable content.
- **Response copy:** one copy icon at the top right of the first non-empty text block, shown on hover/focus and always on touch (44px on phones); content reserves its space.
- **Tables:** natural column widths, whole-word wrapping, top-aligned cells, left headers unless specified, row rules, inside a focusable horizontal scroller. Prose elsewhere and error text wrap anywhere; the pane never scrolls sideways.
- **Mermaid:** the diagram sits in the code block's 1px frame, Source, Open and Copy icons in the right gutter (hover/focus, always on touch). Fixed theme: mono 12px, ink lines, square corners, actors as ink boxes, classic/Dagre layout, 200px wrapping. Diagrams shrink to 75% of natural width, then scroll, never upscale.
- **Tool images:** previews fit 32rem × 22rem.

### Overlays

- **Dialog:** 560px, 80px from the top, 1px ink border over `--scrim`. Panels pad 8px top and 12px sides and bottom. Close is an X flush with the inner top-right corner: 32px desktop, 44px phone, 16px icon.
- **Find:** 640px, 80px from the top, 1px border over `--scrim`: a `>` column and the search input, then results under uppercase group headings, each a 20px row of tile, name with the match marked, project chip and fixed-width age. The active row is inverted. No count, legend, kind column or close control. The orb-link picker is the same dialog.
- **Command picker:** the composer's grid column, at most 420px.
- **Viewer** (tool images, Mermaid Open): native modal over `--lightbox`, sized in `dvh`; 44px X on touch.

### Data

- **Charts** (`apps/web/src/lib/chart-spec.ts` holds the constants): up to three series in ink (solid, dashed, dotted), four to six in `--chart-*` hues; red only for breached thresholds and worse compare rows; mono 11px in `--g3`; 2px data lines, 1px everything else. Series names and threshold labels share a right gutter with collision-spaced, vertically bounded positions and hairline leaders to their endpoints or rules; endpoint dots stay at their data coordinates. Threshold labels truncate at 240px (140px on phones). Phones replace series labels with a one-line key. The crosshair tooltip lists every series, highest first, and closes on any scroll or a press outside the chart; hovering a name fades the others to 12%. `compare` states change as a multiple (`9.5× better`).
- **Usage page:** comparison lines with a left summary rail of metric-size numbers under caps labels. At ≤900px overview and rankings stack with a compact summary grid; at ≤600px phone padding and the range shows dates only. Top orbs: one whole-row link per orb (name, proportional bar, exact count); hover greys and underlines only the name; ≥44px on coarse pointers. Timeline phone keys stay compact (inline-flex, 4px row gaps, no 44px minimum). Rejected: totals-strip meter, project inspector, replacement board, footer call ledger (access); stacked overview, separate lanes, period columns, time grid, weekly six-month buckets, separate SVG rendering (layout).

## Screens

Drawn on the Paper file's Screens page; Resolutions draws each decision, Dark every board in dark.

- **Dashboard:** totals strip, masonry board of project boxes, footer.
- **Orb:** index beside header, header stack, transcript and composer.
- **Dashboard, phone:** one column; totals in two rows.
- **Orb, phone:** no index; back icon, folded header actions, folded composer.
