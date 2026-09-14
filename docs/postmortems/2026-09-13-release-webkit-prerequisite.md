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

## Live release and recovery

Corrected full run `34730567562` for `7fdbc9b` passed the browser-install step,
all checks (including both engines), build, plan, schema, application apply and
IAP repair. The four services updated successfully. At 02:40:04 UTC the
retirement observer failed a Cloud Monitoring HTTP request with the adapter's
`cloud request unavailable` classification after waiting since 02:04. This
classification does not distinguish timeout, DNS or another transport failure;
no more specific underlying cause is established by the preserved log. The
runner recorded applied-but-unvalidated and released its lock, without activating
the new generation or running smoke. No retirement guard or timeout was weakened.

A separate read-only Monitoring query succeeded and returned explicit active and
idle zeroes for the old `pi-orb-00053-rtt` revision at 02:40; pending compute
operations were empty. Rather than repeating build/apply, validation-only GitHub
run `34733669858` targeted the exact failed release ID. It independently verified
the serving deployment, repeated the repair/retirement checks, activated the same
generation and passed lifecycle and identity gates. Its record is `validated`;
all four fixtures were deleted. `docs/deployment.md` records the exact digest,
generation and durable recovery-record identity. Both failed full-run records
remain failed and unmodified; successful recovery does not relabel them green.
