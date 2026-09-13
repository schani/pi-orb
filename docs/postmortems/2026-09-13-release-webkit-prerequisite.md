# Mobile release stopped by missing WebKit prerequisite

GitHub Deploy [34729281559](https://github.com/schani/pi-orb/actions/runs/34729281559)
for `301c543` failed before apply on 2026-09-13. The new mobile suite starts both
Chromium and WebKit, but neither the authoritative release command nor the E2E
workflow installed the managed WebKit binary and its Linux dependencies.
WebKit's suite setup failed at `frontend-mobile.e2e.test.ts:35` because
`/home/runner/.cache/ms-playwright/webkit-2336/pw_run.sh` did not exist.
The other tests passed (98); the seven WebKit cases did not execute.

The durable record
`gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1789261114-8cac488b-460f-4a7a-a0be-12e48c4a1a85.json`
records `failed-before-apply`, failed checks and no artifacts. Production remained
on `858301d`; the release lock was released. This was a missing runner
prerequisite, not flaky browser behavior. The original workflow log and record
remain preserved as failed.

## Correction

`npm run test:e2e:install` invokes the repository's lockfile-pinned Playwright CLI
to install Chromium and WebKit with their system dependencies. Both the release
transaction and standalone E2E workflow run it immediately after `npm ci`, before
image construction or browser tests. The shared script avoids divergent browser
lists. Installer errors fail the ordinary checks gate and remain in the durable
GitHub log; they cannot silently skip an engine or proceed to apply.

A contract test pins both engines and installation ordering in both entry points.
Local dependency/browser installation, all seven preflight contracts and all
14 mobile browser cases (Chromium and WebKit) passed. Live release validation
is recorded in `docs/deployment.md`; this local finding alone is not a deployment
success claim.
