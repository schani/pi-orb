# c9a30a6d: unreachable recovery and Spot preemptions

2026-10-16 investigation; all times below are PDT (UTC−07:00). Orb `c9a30a6d-afb3-4a51-a979-335ae7ac389e`, GCE `us-central1-a`. Read-only investigation; no target state change, restart or deployment.

## Finding and counts

This was not one continuous Spot-preemption loop. By the 08:48:28 PDT capture cutoff, the control plane logged **21 unreachable-restart decisions**: five on October 15 and sixteen on October 16. **Twenty stop/start pairs completed** (five and fifteen respectively); the latest `i5` attempt has no captured completion. Google separately recorded **four preemptions**. The initial loss of runtime reachability remains unexplained.

Count logical Compute operations by `operation.id`, not audit rows: 110 activity rows are 55 successful first/last pairs, with no error status. All name the control-plane service account as caller: **20 stops, 24 starts, six VM creations (`i0`–`i5`), five deletions (`i0`–`i4`)**. The 24 starts comprise twenty unreachable-recovery starts and four post-preemption starts. Provider success does not establish runtime readiness or successful agent work.

Of twenty unreachable cycles, seventeen reached `running → starting`; three completed provider stop/start but then failed the restart budget, without returning to readiness. Three additional `running → starting` transitions handled observed-stopped hosts. The fourth preemption occurred during `starting`, so its extra provider start was not another running-state admission. Thus there were **20 admitted automatic running-state recoveries, 24 successful provider starts**, not 24 successful task resumptions.

## Unreachable-recovery timeline

All 21 decisions record `grace_ms=30000`, `grace_kind=ordinary`, `corroboration=health_no_answer`; measured silence ranges from 30,106 to 33,369 ms. The twenty completed attempts below each have a successful control-plane stop followed by start. “Ready” is the next `runtime_ready` transition, not proof of completed inference. Dates are October 2026; timestamps retain log precision.

| Date / incarnation | Unreachable decision | Host-start `outcome=ok` | Next readiness / terminal outcome |
| --- | --- | --- | --- |
| 10-15 / i0 | 13:12:12.935519 | 13:12:48.360558 | 13:13:41.776141 ready |
| 10-15 / i0 | 14:08:31.053872 | 14:09:30.296750 | 14:10:29.455850 ready |
| 10-15 / i0 | 14:22:08.083865 | 14:22:54.244971 | 14:23:53.047008 ready |
| 10-15 / i0 | 14:25:18.574574 | 14:25:58.576131 | 14:26:51.563845 ready |
| 10-15 / i0 | 15:03:30.043536 | 15:04:23.283773 | 15:05:16.339349 ready |
| 10-16 / i2 | 06:35:35.501618 | 06:36:32.345910 | 06:38:30.805736 ready |
| 10-16 / i2 | 06:54:56.639449 | 06:55:36.207651 | 06:56:29.875198 ready |
| 10-16 / i2 | 07:06:24.099613 | 07:07:30.674391 | 07:08:37.953110 ready |
| 10-16 / i2 | 07:09:28.717335 | 07:10:25.548964 | 07:10:25.708849 budget failure |
| 10-16 / i3 | 07:14:55.396630 | 07:15:52.583852 | 07:16:51.524496 ready |
| 10-16 / i3 | 07:17:44.772890 | 07:18:41.584774 | 07:19:34.916874 ready |
| 10-16 / i3 | 07:32:55.514042 | 07:33:52.189699 | 07:34:51.578604 ready |
| 10-16 / i3 | 07:35:32.801676 | 07:36:30.824490 | 07:37:30.282295 ready |
| 10-16 / i3 | 07:38:12.966184 | 07:39:10.889880 | 07:40:11.061602 ready |
| 10-16 / i3 | 07:41:08.325247 | 07:42:03.556249 | 07:42:03.682193 budget failure |
| 10-16 / i4 | 07:56:52.215012 | 07:57:36.848162 | 07:58:37.527199 ready |
| 10-16 / i4 | 07:59:30.601092 | 08:00:11.731088 | 08:01:13.599558 ready |
| 10-16 / i4 | 08:02:02.825214 | 08:03:08.191471 | 08:04:01.145472 ready |
| 10-16 / i4 | 08:04:56.170199 | 08:05:51.134451 | 08:06:56.560949 ready |
| 10-16 / i4 | 08:42:07.026028 | 08:43:35.146151 | 08:43:35.278639 budget failure |

The five October 15 cycles are the earlier reachability restarts left unexplained in `docs/postmortems/2026-10-15-claude-delivery-uncertain-c9a30a6d.md`. At 15:28:56.966066, a fresh runtime answer deferred another restart. The separate `claude_delivery_uncertain` failure at 15:29:05.334904 preceded VM deletion; explicit Start at 15:30:33.460983 created `i1`, which rejected the same uncertain receipt at 15:31:33.859159. That receipt-normalization defect is established in the earlier postmortem; it does not explain the preceding silence episodes.

## Actual preemptions

These are four distinct `compute.instances.preempted` system events, each `system@google.com`, with different operation/trigger IDs. Instance IDs are `3896055770277452315` (`i2`) and `307923444182254708` (`i4`). They are not duplicates of control-plane stop requests.

| October 16 preemption | VM | Recovery evidence (PDT) |
| --- | --- | --- |
| 06:32:10.159868 | `i2` | `host_observed_stopped` transition 06:32:30.236126; start OK 06:32:42.222768; ready 06:33:36.381651. |
| 06:36:57.746812 | `i2` | After unreachable-recovery start at 06:36:32.345910, while already `starting`; extra observed-stopped start OK 06:37:25.305280; ready 06:38:30.805736. |
| 06:46:06.545262 | `i2` | `host_observed_stopped` transition 06:46:21.074996; start OK 06:46:29.284773; ready 06:47:34.801298. |
| 08:38:54.213139 | `i4` | `host_observed_stopped` transition 08:39:07.930605; start OK 08:39:15.621298; ready 08:40:16.275051. |

The 06:36:57 preemption followed, rather than caused, the 06:35:35 unreachable decision. Spot scheduling is also confirmed by retained `current-instance.json` for `i5` (`SPOT`, termination action `STOP`). No preemption event in this capture accounts for the twenty control-plane-initiated stop/start cycles.

## Budgets and later state

The rolling budget admits five automatic running-state restarts per hour, not five lifetime boots. `i2` admitted two observed-stopped and three unreachable transitions before failure; `i3` admitted five unreachable transitions; `i4` admitted four unreachable plus one observed-stopped transition. The additional `i2` start while already `starting` did not add a running-state transition. Explicit Starts at **06:21:53.532944, 07:12:34.396327, 07:54:17.341181 and 08:44:44.751669** cleared the budget and created `i2`–`i5`; later cycles therefore do not establish an unbounded autonomous retry from `failed`.

Crucial limit in the captured build: the unreachable path stopped/started the VM **before** `autoRestart` checked the transition budget (`apps/control-plane/src/domain/lifecycle.ts`). All three budget failures followed successful provider starts, then fenced compute deletion. The budget bounded admitted recovery transitions, not those three final provider restart operations. The local correction below prevents effects for an already-exhausted snapshot.

The separate interrupted-turn boot guard allows three automatic claims after human input; it is not the compute restart budget and does not count successful completions. October 16 readiness edges, including `i5`, report thirteen `resumed`, two `notified_restart` and four `declined_already_resumed`; declines occurred at 07:19:34.916986, 07:55:23.972410, 08:06:56.561066 and 08:40:16.275155. Those are runtime-reported decisions, not proof that model work completed.

The original control-plane capture ends with `i5` replacement provisioning at **08:44:55.671199**. Retained instance metadata reports RUNNING, last start **08:44:54.964**; serial output records `orb runtime ready` at **08:45:59.650579**. Supplemental `latest.json` records `running` at **08:46:04.336434**, then history timeouts at **08:46:26.562937** and **08:47:21.710855**. `latest-final.json` adds another unreachable decision at **08:47:52.030324** (`silent_ms=30190`, `health_no_answer`); no completed stop/start or subsequent state outcome is captured as of **08:48:28**. Replacement spec `4ed77a016141` is unchanged across `i2`–`i5`; these were not recorded spec rollovers.

## Causal boundary

The immediate reasons are established: unanswered runtime requests plus failed health corroboration caused the twenty-one control-plane restart decisions; four provider preemptions caused separate stops. The captures do not establish why runtime requests went unanswered. A timeout does not identify a guest crash, OOM, event-loop stall, network failure or provider rejection. Neither the known receipt defect nor Spot status supplies that missing causal evidence.

`guest.json` contains GCE-agent logs, not the historical kernel/OOM/application logs needed to diagnose these silence episodes. Serial output for deleted VMs was unavailable. Current-VM readiness cannot explain earlier boots. The prior disk inspection established native consumption and a missing normalized receipt, not the exact prior process exit signal/code. No root cause or corrective fix for runtime silence is claimed.

## Correction and regression evidence (2026-10-16)

After failed health corroboration, check the existing snapshot budget before restart logging, pending-restart memory or provider stop/start. Exhaustion retains the failure/discard CAS, manual stop reason and agent-admission fence. Successful recovery still charges at the post-provider `starting` CAS; retryable provider errors remain uncharged. No persisted state change or cross-reconciler reservation was added; concurrent budget charges can still invalidate that final CAS. Not deployed.

Tests first: the exhausted-budget regression issued a stop/start before failing; its recorded trace was replayed before correction (`test-failures/unreachable-restart-budget-exhausted-1792166109132-0.json`). Seven preserved DST traces were reviewed; reconstructed failing variants and replay logs are in `/tmp/restart-review-replays/exact/` (IDs below are filename timestamps):

- `1792166076929` (`exhausted`), `1792166076946` (`last_slot`), `1792166076949` (`expired_slot`): missing `noteStateEpisode` initialization cleared seeded liveness, producing `noop`. The harness was corrected; reconstructed variants reproduce this failure.
- `1792166109132` and `1792166142335` (`exhausted`), `1792166142354` (`stop_race`): the missing product precheck allowed provider effects. Reconstructed precheck-free variants reproduce those effects.
- `1792166161643` (`exhausted`): a broad log assertion counted both the failure transition and discard request. The assertion now selects the transition; the broad variant reproduces the failure.

Original traces remain in `test-failures/`. Current-code replay diverges where older execution paths changed; this is not a claim that all seven original replays passed directly. The replacement regression checks exhaustion without provider effects, the fifth admission and a newer Stop winning the failure CAS, using the existing deterministic harness. The replacement first failed without the precheck (`unreachable-restart-budget-exhausted-1792170121582-0.json`, `unreachable-restart-budget-stop_race-1792170121625-0.json`): both issued a provider stop. Immediate automatic replays reproduced both; standalone replay after correction diverged at the changed timer path. Isolated precheck-free reconstruction reproduced both original assertions (`/tmp/pr134-rewrite-validation/budget-red/`). All 68 lifecycle tests then passed. Runtime request-error messages and supervisor-local health/exit observations improve future evidence; they do not explain the historical silence.

## Preservation

Private frozen captures are in `/workspace/evidence/c9a30a6d/restarts-2026-10-16/`: `control-plane.json` (240 records), `system-events.json` (four), `compute-activity.json` (110), `guest.json`, `current-instance.json`, `i5-serial.txt`, `i5-serial.stderr`, supplemental `latest.json`/`latest-final.json`, gatherer `summary.txt`/`timeline-pdt.txt`, and `SHA256SUMS`. The summary/timeline predate the last decision; supplemental raw records establish the final count. These are local evidence, not durable published artifacts. Primary SHA256s:

- Control plane: `2047db98081f46c2e5b6ae007ccabb0859e0d20ae6360e13039e5d5e0de80cf8`
- System events: `7655ae83d0c6e564039a4ac94f7988fb92f4a386141f09cc73c6ee8e66dd7881`
- Compute activity: `5364c84a2e97627508f8e575929a02a4dcc3d06997b15c5acf105d5a452494ec`
