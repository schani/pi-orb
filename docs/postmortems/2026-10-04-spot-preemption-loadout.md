# Spot preemption and secondary loadout errors (2026-10-04)

## Finding

Google preempted this orb's Spot VM twice. The persisted `prepare_loadout` errors followed shutdown admission; they did not initiate these shutdowns. The exact secondary exception is unknown.

Sanitized evidence: `.context/loadout-failure/{findings.md,gce-stop-audit.json,orb-lifecycle.json}`. Cloud queries covered this instance and these two windows only. Instance metadata confirmed `provisioningModel: SPOT`, `preemptible: true`, `instanceTerminationAction: STOP`.

## Timeline

All times are October 4, 2026, PDT (October 5 UTC). Audit publication follows guest shutdown evidence.

| Event | First incident | Second incident |
| --- | --- | --- |
| ACPI power key; logind begins poweroff | 9:17:00.252 PM | 9:35:05.415 PM |
| Persisted `prepare_loadout` error | 9:17:00.952 PM (+700 ms) | 9:35:05.919 PM (+504 ms) |
| GCE `compute.instances.preempted`, `system@google.com` | 9:17:07.353 PM | 9:35:13.381 PM |
| Lifecycle running → starting, `host_observed_stopped` | 9:17:22.097 PM | 9:35:32.838 PM |
| Control-plane `compute.instances.start` | 9:17:23.340 PM | 9:35:34.237 PM |

Systemd stopped the runtime and killed remaining test/browser descendants. No control-plane stop operation appeared in the scoped audit windows. Recovery was observed-host-stopped handling, not an idle-stop decision.

These findings do not classify earlier restarts. The inspected retained boot journals had no OOM/panic/ENOSPC signature; that is not proof of historical memory or disk availability, nor a diagnosis of uninspected boots.

## Secondary failure boundary

The managed `/app` Pi SDK catches loadout-hook exceptions and emits error text and stack. Its adapter persists only extension path and event, discarding `error.message` and stack. Both retained entries identify the inline codemode extension and `prepare_loadout`; neither preserves the exception.

Loadout preparation renders tool declarations and schemas; it does not invoke classifiers or model providers. Shutdown disposes extension contexts, but stale context is only a candidate. Malformed schemas, provider failure and quota are not established causes. No full exception or provider response is reproduced here. Sanitized exception evidence is tracked once in `TODO.md`.

## Qualification and recovery

Whole E2E attempts were interrupted without final summaries and are not acceptance evidence. The workaround retained completed logs and exit statuses in the workspace, froze source, and ran sequential bounded test-file groups across preemptions. Before/after source hashes matched. Current UI qualification passed 2,755 unit/DST tests (eight conditional skips), 113 infrastructure tests, workspace/E2E typecheck, and 172 affected browser/E2E cases across six files, including Docker/PostgreSQL full-slice. This is affected coverage, not a complete current-suite pass; see `docs/testing.md`.

The local service was restored with retained database/auth state and a completed frontend build. Claude stayed connected; the user's orb stayed stopped, with no automatic replay. No lifecycle policy, timer, automatic-resume behavior or Spot provisioning setting was changed.

## Rule

Join guest shutdown admission, provider audit and durable lifecycle edges before blaming an extension notice for a restart. Preserve sanitized failure evidence and completed qualification across preemption. Interrupted work is not a pass, and restoring a service does not authorize replaying user work.
