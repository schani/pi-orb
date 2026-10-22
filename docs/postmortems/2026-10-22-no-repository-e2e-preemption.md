# Name-only project E2E interrupted by Spot preemption

Confirmed external interruption on 2026-10-22; the original full E2E run is **incomplete, not passed**.
VM `pi-orb-353a3737-6d98-4d02-b4df-bef856f8c618-i0` (ID `701389139084807314`, `playground-dev-6ae7/us-central1-a`) was GCE Spot, termination action `STOP`.

Timeline (America/Los_Angeles, PDT; UTC−07:00):
- **10:04:26.135700** (`17:04:26.135700Z`): guest journal records power key/poweroff; runtime service stopping at **10:04:26.566600**.
- **10:04:26.583799225** (`17:04:26.583799225Z`): guest agent receives SIGTERM.
- **10:04:26.724874034**: original log's last write reports WebKit project-instructions failure, **141 ms after SIGTERM**; no assertion or suite summary survives.
- **10:04:27.009807**: systemd explicitly SIGKILLs E2E npm PID `10441` (`npm run test:e2`), its parent bash and Vitest tree.
- **10:04:36.671726**: GCP audit confirms `compute.instances.preempted`, `Instance was preempted.`, insert ID `e5n76ud1t3e`.
- **10:04:53–10:05:57**: reconciler observes stopped host, starts the same VM once, and records runtime ready; no replacement instance.

Shutdown/process-kill evidence supports the external root cause under the existing no-flake rule; a green rerun does not clear a failure.
The exact failing Playwright operation is unavailable; a simultaneous unrelated assertion cannot be excluded. No product/test fix or stabilization is claimed.
Scoped process-backend E2E qualification is complete across frozen-source runs: the original log contains **29 completed passing files / 360 tests**; independent focused Chromium/WebKit checks passed **1 file / 2 tests** with no concurrent suite; the remaining selection exited **0**, with **34 files / 98 tests passed**, **one PostgreSQL file / two tests skipped** (PostgreSQL/Docker). Total: **64 files / 460 tests passed**, accounting for all **65 selected files**. The interrupted case is excluded; the original run remains incomplete, not green.
`source-qualified.log` verifies every `source-freeze.sha256` entry; final typecheck and lint pass (411 baseline warnings, 83 infos). No full unit-suite pass or production deployment is claimed.

Evidence (paths below relative to `.context/no-repo/`; hashes SHA-256):
- `host-interruption.md`: journal reproduction, prior boot `e683f35c87794bac887f5b2926ac6535`, commands and investigation; temporary browser artifacts did not survive.
- `e2e-full.log`: 66,682 bytes, no completion `.exit`; `1e90240f738e81360d61eaece1507b98edc5925c975d10472d2fe0a74d18e574`.
- `host-interruption-cloud.log`: sanitized read-only audit/lifecycle/scheduling excerpt with query and operation IDs; `bc566a4a22b178717ea5c633dca8bdb1bdbbb9cbc57e3c9fd24b2edba4de7af0`.
- `project-instructions-first-repro.log`: independent focused pass; `13aad789386cfce366d610d48dd45cd85793ff8756b6dd8340cf26595b006b0a`.
- `e2e-remaining-files.txt`: exact remaining selection; `edb8fc47b8c3c7c78938f3ba9d64fddcb699205b3251c04f3df4c90bddfda523`. Source freeze: `source-freeze.sha256`.
- `e2e-remaining.log`: completed remaining selection, `e2e-remaining.exit` is `0`; `de6fec8c1906dd2aee0719d35607018950f97b180a9bd8207e668690c59e7c51`.
- `source-qualified.log`: freeze verification; `08e7ea59e35a86ab75b7fb5f8349a091fa3ae841b08e764e6aa33d8c4d8d0a81`. Final checks: `typecheck-qualified.log`, `lint-qualified.log`.
