# WebKit index click lost to layout shift — 2026-10-11

[Durable qualification 38157057668](https://github.com/schani/pi-orb/actions/runs/38157057668), job "Central process (2/4)", on `7c42ab17` timed out (720 s) in `e2e/frontend-session.e2e.test.ts` "webkit: reuses one Claude owner connection across immutable harness creation choices". The Claude iteration completed; in the Pi iteration the click on "New Pi orb in scratchpad" issued no create POST, so the held-POST barrier never resolved. The same test passed on `bcafe4ad` and `6090c00f`. First-failure log and artifacts: `.context/durable-qual-38157057668*` in workspace `los-angeles-v1`.

## Defect and evidence

The orb index renders every project header with a `loading…` status, then each project's orb list arrives separately; `scratchpad` is last, so earlier lists move its header. `gotoFrontendHistory` waits for projects and history, not per-project lists. Playwright checks the hit target only at pointerdown; a list landing before pointerup moves the link, and WebKit dispatches `click` to the common ancestor `<nav>`. The link handler never runs while `locator.click()` succeeds. Instrumented events: `pointerdown:A:New Pi orb in scratchpad` → `pointerup:A:New Pi orb in fieldnotes` → `click:NAV:All project orbs`.

The unmodified test did not fail locally. Delaying earlier list responses by 60–140 ms lost 12/600 WebKit clicks and 0/200 Chromium clicks. The session stayed `active` on every POST, so the 2026-10-11 `auth_required` request suppression is not involved; PR 72 changes only transcript pointer handling. Evidence: `.context/diag-webkit-create-*`.

## Correction and invariant

Index create clicks wait until per-project loading has finished (`frontend-session`: no `role="status"` in the index; `harness-icons-frontend`: no `.project-progress`). With the wait, 0/600 clicks were lost and the real test passed 20/20 and 5/5. Product-side layout reservation is tracked in `TODO.md`.
