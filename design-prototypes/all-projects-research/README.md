# All-project navigation: product research

The initial study was rejected by the user for not respecting the current product's design. The rationale and revised proposals are recorded in `docs/web-ui.md`.

## Evidence

- `orb.png`: unmodified frontend-only fixture at `#/orbs/frontend-fixture-orb`, 1440×1000.
- `dashboard.png`: unmodified frontend-only fixture at `#/`, same viewport.
- `metrics.json`: computed styles and bounding boxes measured on that orb route.

These are screenshots of the current repository's real React frontend, running via `npm run dev:frontend`, not screenshots of the deployed account. The fixture-only authentication control visible at bottom right is not production UI and is not copied into the studies.

Inspected `apps/web/src/styles.css`, `components/OrbIndex.tsx`, `components/ProjectHeader.tsx`, `components/StateTile.tsx`, `components/Icons.tsx`, `pages/ProjectsPage.tsx`, `pages/OrbPage.tsx`, and the visual decisions in `docs/web-ui.md`.

The revised `design-prototypes/all-projects-orb.html` embeds the actual stylesheet verbatim (SHA-256 `0eb51755e13ad36cc84160794cdeceff69763717f4832b918aa455749834ddff`), the rendered utility sprite, and the actual favicon SVG bytes as data URLs. Its transcript template was captured from the running React frontend, with fixture diagnostics and introductory content removed and the user message replaced with the navigation request. No captured caret overlay or runtime connection is retained. Navigation rows reproduce the source components' markup against that stylesheet. Additional CSS changes layout ownership for the comparison frame, not the product's typography, colors, icon geometry, header heights, or transcript record spacing.

## Validation

After `npm ci`, serve the repository with a static HTTP server on port 8091 and run:

```sh
node design-prototypes/all-projects-research/verify.mjs
```

`STUDY_URL` overrides the URL; `CHROMIUM_PATH` overrides `/usr/bin/chromium`.

Verified all six compositions (current baseline plus five proposals): byte-identical embedded CSS; measured body, project header, orb header, row, tile, transcript prefix, and composer geometry; all projects and orb links; SVG loading; cross-project selection; browser Back and draft isolation; archive/read-only presentation; native tool disclosures; reference screenshot loading; and navigation on a 1024px desktop canvas. Manually inspected screenshots at 1440×1000. No production code or runtime protocol changes.
