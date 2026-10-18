# False idle during release handoff

## Finding — 2026-10-18, PDT

Reported: header/sidebar showed idle while orb `05784d6c-7971-4abc-8f91-a3d0ddde73f3` (“Deploy PR 144 and monitor”) was working. Source `7058fc5599e98ecedbcb3abc059c911a881af92f`; [Deploy 39147923107](https://github.com/schani/pi-orb/actions/runs/39147923107), release `r-1792344195-379c86bc-0317-40b1-8d7d-5c35b60dddc8`.

**Confirmed:** HTTP reached the new revision before it acquired agent ownership. Both metadata and unloaded conversation reads can label unobserved activity idle. **Inferred:** this caused the reported display. No screenshot-time response body, WS frames, exact screenshot timestamp or authoritative native busy frame was retained. No long-tool timeout is needed to explain this mechanism.

Deployment is the observed trigger, not a necessary condition: the unknown-to-idle default can also apply during startup, recovery or ownership handoff. No evidence attributes other reported occurrences to this mechanism; those were not reproduced.

## Evidence — all times PDT, 2026-10-18

| Time | Observation |
| --- | --- |
| 10:38:14.139 AM | New revision `00064-dmf` starts; service update ready at 10:38:33.175 AM. |
| 10:38:37.062–10:38:50.256 AM | Old `00063-l56` logs shutdown; revision deletion completes. Neither proves immediate process exit. |
| 10:39–10:51 AM | One-minute Monitoring samples show one active instance **per revision**. |
| 10:50:27.911 AM | Old revision's `codemode.memory` names target as `worker_max_orb`: retained worker allocation, not an authoritative busy observation. |
| 10:50:32.027 AM onward | Firefox target HTTP reads reach new revision. Historical WS requests at 10:50:32, 10:51:05 and 10:51:37 AM also reach it; frames unavailable. |
| 10:52:00 AM | Old revision reports explicit active=0 and idle=0 samples. |
| 10:52:50.689–10:52:51.968 AM | New revision activation granted, target ownership acquired (`fence=2`), then `harness.opened recovered=true`. |
| 10:55:22.027 AM | First retained HTTP body reports `running`, `centralAgent=true`, `busy`. |
| 10:58:21.332–.482 AM | Paired HTTP/WS/HTTP reads all report busy on new revision; WS shows running codemode, revision 141, operation `submission:15`. No live false idle reproduced. |

`infra/run.tf` sets min/max=1 under **revision** `template.scaling`, not service-wide scaling. Two revision-instance groups during rollout do not violate that limit. The target VM is execution compute; central agent authority resides in Cloud Run.

## Confirmed source mechanisms

1. **Metadata:** `apps/control-plane/src/domain/control-state.ts` stores activity in a process-local `agentWork` map; `hasAgentWork` returns false for a missing entry. `apps/control-plane/src/http/views.ts` maps that false to central `activity: "idle"`. Unknown and observed quiescence collapse. Central polling in `apps/control-plane/src/domain/lifecycle.ts` writes local session `workActive`; `apps/control-plane/src/main.ts` starts HTTP **before** waiting for release activation and starting autonomous loops. New-revision reads can therefore report idle while another revision still owns the work.
2. **Conversation/WS:** `DurableAgentPlane.readSession` in `apps/control-plane/src/adapters/durable/manager.ts` returns a stable read handle without acquiring ownership. An unloaded `StableAgentHandle.readSnapshot` in `apps/control-plane/src/adapters/durable/handle.ts` reads persistence; `apps/control-plane/src/adapters/durable/pg-persistence.ts` hardcodes persisted snapshot activity to `"idle"`. `apps/orb-runtime/src/domain/sync.ts` sends that activity in synchronized status. A **new-revision** read-only WS can also publish false idle; an old-revision socket is not required. Historical WS frame contents remain unknown.

## Deterministic source repro — not historical replay

After sole-installer `npm ci` succeeded at 11:01:50 AM, a temporary sibling of `views.test.ts` reused its `OrbRow` fixture and called:

```ts
const view = orbView(orb, new ControlState(), { centralAgent: true });
expect(view.activity).not.toBe("idle");
```

At 11:02:03–05 AM, `npx vitest run apps/control-plane/src/http/views.false-idle-investigation.test.ts` deliberately failed: **1 test failed, exit 1**, `expected 'idle' not to be 'idle'`. This asserts recommended unknown-not-confirmed-idle behavior, not an approved contract. It proves the empty-observation metadata conversion on the inspected source, not a full cross-revision schedule, the persisted-snapshot path or the screenshot's historical body. No rerun to obtain green; temporary test removed. Existing `views.test.ts` then passed 27/27 at 11:02:55–56 AM (`views-existing.log`); this is baseline validation, not a correction. No product source or persisted state changed.

## Evidence and recommendation

Private originals: `/tmp/idle-investigation-20261018/REPORT.md`, `run-audit.json`, `run-system.json`, `rollover-logs.json`, `instance-metrics.json`, `target-edges.json`, `target-ws-requests.json`, `service-detailed.json`, `release.json`, `orb-first.json`, `current-{before,after}-ws.body.json`, `current-ws-status.json`, `current-request-routing.json`. `release.json` records identity-phase applied-but-unvalidated state, not a final deployment result. Repro source/output: `views.false-idle-investigation.test.ts`, `false-idle-red.log`; installation: `npm-ci.log` in the same directory. `repro-SHA256SUMS` fingerprints the retained repro source, red output and installer log.

**Recommendation, unimplemented and not an approved design choice:** distinguish unobserved activity from confirmed idle across metadata and unloaded conversation synchronization. Correction and content-free ownership/observation diagnostics are tracked only in `TODO.md`. Current routing/status logs cannot reconstruct historical payloads. No product fix, deployment or persisted-state change is authorized by this investigation.
