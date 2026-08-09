# 2026-08-09 — private-repository clone outside the GitHub App installation leaves an orb creating

Status: root-caused; affected orb not recovered; failure-reporting defect fixed and covered by DST/full-slice E2E on 2026-08-09. Repository-access policy remains open in `docs/open-questions.md` question 11/25.

**Field finding:** orb `9056ea5c-17df-4ee0-a53c-71f7a3be4634` stayed visibly `creating` even though its runtime had already failed to clone private repository `glideapps/fling`. The broker successfully issued a valid GitHub user-to-server token, but the app is installed only on account `schani`; GitHub App tokens are limited to the intersection of user access, app permissions, and installation repository access. The token therefore saw `GET /repos/glideapps/fling` as `404`, and `git clone` failed `403` with “Write access to repository not granted.”

Timeline (UTC):

- 18:17:01 — orb row created for project `0e6ad7dd-53d2-4ffc-8087-21baee3cd13b`.
- 18:17:13 — reconciler created GCE host `pi-orb-9056ea5c-17df-4ee0-a53c-71f7a3be4634`.
- 18:18:05 — runtime container started from the expected digest; its model and GitHub broker token requests both returned `200`.
- 18:18:07 — runtime began listening, then clone failed `403`. Tailscale subsequently reached `Running`; the VM and container themselves remained healthy.
- 18:26:28 — browser/API still reported `creating`, state version 1, with no user-visible error.
- 18:32:19 — the global deadline finally moved the orb to `failed`, but `last_error` was the secondary symptom (`deadline_exceeded`, 145 probes, final `ECONNREFUSED`) rather than the already-known `clone_failed` cause. The existing API/UI explanation plumbing worked, but carried the wrong diagnosis 14 minutes late.

Two defects combined:

1. **Repository authorization is not validated before host provisioning.** A successful GitHub ceremony and token grant prove only that the user authorized the app; they do not prove the app is installed for the selected repository. The live installation inventory contained one installation for `schani` with `repository_selection=all` and `contents=write`, but no installation on `glideapps`. “All repositories” is scoped to the installation account, not every repository the user can access.
2. **The one-shot runtime clone failure is marked retryable, but nothing retries it.** `PiOrbAgent.boot()` records `clone_failed` and returns while the HTTP server remains reachable. The control plane sees `status=failed` with `retryable=true` and keeps waiting in readiness until the 15-minute create/start deadline. The runtime does not re-enter `boot()`, so the orb cannot recover during that wait. The UI consequently shows only `creating` instead of the known clone error.

What went right: the VM, startup script, image pull, broker routes, container-state reporter, Tailscale path, and runtime HTTP server all worked. Cloud Logging contained the exact clone error, and read-only GitHub API checks proved the installation boundary without exposing token material.

Recovery for this orb requires first making `glideapps/fling` accessible to the GitHub App — which may require a public/org-owned app plus Glideapps administrator installation/approval for the repository — or selecting a repository inside the existing `schani` installation. Because runtime boot is one-shot, installation alone does not retry this clone; stop/start or recreate the orb after access is corrected.

Resulting rules:

- Repository selection/create should preflight effective GitHub App installation access, or at minimum reject/surface inaccessible private repositories before spending a VM boot.
- A runtime initialization failure must either retry internally under an explicit bounded policy or become a prompt typed lifecycle failure. Implemented 2026-08-09: every returned runtime-health `failed` now takes the existing durable `runtime_failed` transition regardless of its legacy `retryable` label; DST covers the formerly ignored `clone_failed` shape and the full-slice E2E covers a real inaccessible-repository clone.
- Token issuance, app installation, and per-repository authorization are separate checks. A `200` from `tokens/github` is not proof that a selected repository is accessible.
