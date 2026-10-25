# Lifecycle semantic fault discovery

2026-10-25 PDT. Modeled reproductions, not attribution of a production incident.

## Findings

- Controlled drain dropped replication-store invariant classification. An independent age guard could fail/dispose answering execution before another pull, including under a fresh controller. Local transient store errors likewise supplied no runtime-failure evidence.
- Central-running guest probes treated every answer as reachability without consuming terminal health. Healthy central activity/history concealed failed execution.
- Random transport failures could not produce either missing semantic input. More seeds alone would not repair that model gap.

## Decision

`docs/lifecycle.md`: drain-store errors never authorize compute disposal. Invariants retain their original visible blocker and park through existing classified scheduling; transients retry. Runtime-silence corroboration, the stopping restart cap, integrity/terminal failures and the sleep provider-stop-after-catch-up budget remain. Responsive-but-unready drains may remain blocked; controller restarts do not establish a global silence deadline. Classification-only parking was rejected because another controller can hit the age guard first.

Central-running terminal guest health uses the existing identity/version-fenced failure/discard operation. Central admission/conversation/history survive; ordinary terminal health grants no automatic replacement. HTTP/schema errors still prove reachability without proving terminal failure. No schema, persisted-state or prompt change.

## Generalized model

The existing campaign samples all 59 injectable store operations from complete typed metadata, persistent/clearable invariant/transient faults, guest health outcomes independently of reachability/provider/central activity, time and fresh controllers. Two callers and compute/history workers retain real port boundaries. No defect-specific fixture, command, suite or seed selection was added.

Port receipts fence running/stopping failure authority by execution identity/episode. Any answered execution port invalidates silence; disposal requires terminal/provider evidence or a fresh post-restart no-answer after its grace. Terminal-health convergence is scoped to the reconciler's actual input version; only an actual matching failure-write StoreError excuses that pass. Current committed incarnation fences authorize provider discard. Quiescence honors Stop, conserved receipts and fresh current-failure wake authority.

Generic primitive contracts cover every advertised store operation and independent health/reachability/activity. Existing loop contracts cover returned-invariant parking. The campaign does not independently detect classification-only reversion with disposal timers absent; the drain mutation below restores both. Existing startup tests own readiness deadlines.

## Evidence

Retained in `.context/lifecycle-fault-campaign/` and `test-failures/` in the lifecycle worktree:

| Unchanged generalized generator; independently restored production branch | Outcome | Representative trace |
| --- | --- | --- |
| Original drain, seeds 0–63 per placement | 8 fail / 120 pass | `lifecycle-campaign-guest-seed-21-1792936727978-0.json` |
| Original central guest-health branch, seeds 0–63 per placement | 8 fail / 120 pass | `lifecycle-campaign-central-seed-4-1792936765982-0.json` |
| Original drain, guest seeds 64–255 | 32 fail / 160 pass | `lifecycle-campaign-guest-seed-90-1792936835364-0.json` |

Guest 90 independently draws an `initOrVerifySession` invariant, Stop, fresh controller and elapsed time while execution answers; its boundary oracle rejects the resulting failure authority. Guest 88 also draws repeated invariant drain attempts across controllers. Each of these 48 mutation failures was explicitly replayed with `DST_REPLAY` on its unchanged mutant before restoring fixes. Manifests: `mutation-{drain,guest}-traces.tsv`, `mutation-drain-expanded-traces.tsv`; matching replay logs retain the assertions. Strict old-trace success after a control-flow fix is not claimed.

Earlier discovery and harness REDs remain retained/replayed. Harness corrections distinguish accepted startup episodes, stale reconciliation versions, absent versus replacement runtime instances, actual failed-write receipts and fresh current-failure inbox wake authority. No passing rerun alone cleared a failure.

The uniform default increased from 64 to 256 seeds per placement after semantic expansion; each seed's entropy is unchanged. Restored default: **512 pass**; final nine-file lifecycle/store/primitive qualification: **727 pass**. Current-source receipts and SHA-256 seal are in `final-512-campaign.log`, `final-focused-512.log`, `final-root-{typecheck,lint}.log` and `final-source.sha256`. These are local modeled checks, not whole-repository unit, E2E, PostgreSQL, cloud or deployment qualification.
