# Native acceptance entry mismatch — 2026-10-09

[Deploy 37932201659](https://github.com/schani/pi-orb/actions/runs/37932201659) on `94983be1847b88ef9ebd8e05cc417ea70a0e410b` failed native `validate:probe` before migration/apply. Release `r-1791550048-7e6c12e6-3529-4941-ba3c-39723466b101` records `failed-before-apply`, no fixtures/migration job and six successful owned cleanup operations. Production remained `pi-orb-issuer-00046-wf8`, generation `1791493106`; its active release pointer was unchanged. No backend activation, rollback or sustained rollout monitor ran.

## Defect and evidence

The integration changed supervisor child argv to `/usr/local/bin/node apps/orb-runtime/src/runtime-entry.ts`, selecting Pi or execution by runtime mode. Native acceptance still searched that supervisor's children for `apps/orb-runtime/src/main.ts`. Dynamic import does not replace the wrapper's argv, so the matcher cannot identify the supervised child. Its `set -e` exit provides no assertion label.

A tests-first owned real Node child exposes exactly the supervisor's declared argv, waits for explicit readiness, then executes the acceptance script's actual `pgrep --parent --full` pattern. It deterministically fails before the fix (`native-entry.red.log` in `/workspace/durable-activation-deployment-evidence/`). The fixture starts no runtime, listener, model or user process and drains its owned child.

Cloud Logging for validator instance `1694071864917580506` reports runtime ready at `12:56:02Z`; the probe failed at `13:03:33Z`. Its earlier `runtime_exited_before_ready` edge occurs around the validation broker startup/restart. This does not establish which historical shell assertion exited first: private command/serial logs were left in the deleted Actions runner, not uploaded. The stale matcher is a proven release-gate defect, not an exclusive attribution of every captured edge. First workflow log, allowlisted release artifact and private cloud records remain preserved; no job was rerun to obtain green.

## Correction and invariant

Native acceptance follows the supervisor's actual entry argv, still requiring exactly one owned child and the existing supervisor/health/workspace/boot/Claude gates. A missing child emits the fixed `native_runtime_entry_missing` code; other failed shell assertions emit `native_acceptance_failed` and their source line, without command text or payloads. No readiness deadline increase, skip, inference replay, process restart or compatibility alias.

The real-child regression keeps supervisor source and native acceptance synchronized. Local success does not qualify a fresh native VM or the corrected production release; exact-source CI/E2E and a new standard release remain required.
