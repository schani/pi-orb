# Frontend chart qualification (2026-10-23)

PR 186 head `3b07497a` exposed two unrelated WebKit failures:

- [E2E](https://github.com/schani/pi-orb/actions/runs/40045949304/job/120727590119):
  usage link `toBeFocused()` received inactive after resizing.
- [Durable](https://github.com/schani/pi-orb/actions/runs/40045949315/job/120727590193):
  Mermaid's no-pageerror assertion received
  `ResizeObserver loop completed with undelivered notifications.`
  Uploaded DST traces match historical fixtures; no new DST failure.

## Evidence and correction

Holding native matchMedia delivery reproduced the usage race: focus reached the
old SVG link, responsive replacement disconnected it, and the new HTML link was
unfocused. Existing focus, new-tab and activation assertions now target `.chart-key`
at 320px or `.chart-canvas svg` at 1440px. Touch-target assertions are unchanged.

Mermaid's default measurement DIV entered body flow: the otherwise zero-height
body temporarily reached 155.5–646.5px. Supplying a fixed hidden container kept
body height unchanged. Releasing actual font-load completion during deep native
ResizeObserver delivery reproduced the warning with default measurement, not
with the fixed container. This establishes a controlled mechanism, not the
historical CI interleaving or exact warning cause. The adapter owns its container
and removes it in `finally`; no observer scheduler changes or warning filters.

Tests first: both engines rejected in-flow measurement. The regression releases
fonts during native observer delivery, checks fixed hidden measurement and
container removal, and retains every functional/no-pageerror assertion.
Mermaid and usage files each pass Chromium/WebKit locally; hosted exact-head
qualification remains required. The approved UI stabilization exception permits
correction without claiming historical warning attribution.

Evidence: `.context/pr186-ci/job-120727590119.log`,
`durable-40045949315-job-120727590193.log`, downloaded artifacts,
`usage-scoped-focus-diagnostic-synchronized.log`,
`mermaid-font-delivery-{A,B}.log`, `mermaid-regression-red.log`,
`mermaid-regression-final.log`.
