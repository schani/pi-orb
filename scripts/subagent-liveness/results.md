# Results — 2026-09-05

Environment: Linux, Node 24.20.0, published gotgenes 21.4.2, Pi SDK 0.85.1. The lockfile pins all dependencies. No installed package source was modified.

Final run: **7 passed, 0 failed**, approximately 9.5 seconds. The original `seven-scenarios.txt` was not recovered into the tracked evidence. The later recovered baseline output is archived as `recovered-baseline.txt`; download details are in `evidence/README.md`.

## Liveness: feasible without a fork for the tested scope

The candidate public-API bridge reported exactly `busy → idle` once in every scenario, remaining busy while the root was idle but its child was working, and through the child-result wake of the root.

The decisive parent-first boundary:

```text
root agent_settled:       parentIdle=true,  bridgeBusy=true
child terminal callback: parentIdle=true,  hasRunning=false, persisted=false
after callback drain:    parentIdle=false, persisted=true,  bridgeBusy=true
root follow-up starts
root follow-up settles:  parentIdle=true,  bridgeBusy=false
```

The child-first boundary is different: the root's first `agent_settled` SDK notification arrives with `parentIdle=false`, because the extension's settled hook has already scheduled its withheld completion wake. Blindly clearing the root activity on that event would be incorrect.

The bridge holds admitted child identities until the terminal callback's synchronous persistence/notification work has finished (microtask boundary) and samples the real root `isIdle`. It does not inspect private notification state or run promises. This works for these pinned versions and scenarios, not necessarily future package/SDK orderings.

## Cancellation: three separate findings

1. **Running cancellation is not drained by the status/wait API.** The controlled tool observed the abort but remained blocked in cleanup. Meanwhile the record was `stopped`, `hasRunning()` returned false, and `waitForAll()` resolved. No terminal callback had fired. An admission-to-terminal activity hold correctly kept the bridge busy.
2. **Cancellation during startup is lost.** The driver aborted during blocked workspace preparation, before child session/model/tool creation. On releasing preparation, the child model and tool still executed; the tool never observed the earlier abort. Its public record remained `stopped` and `hasRunning()` remained false. The admission-to-terminal hold still protected activity, but it cannot repair cancellation.
3. **Cancelled children wake the root.** After cancellation actually unwound, the extension persisted its failed/stopped result and triggered another root model turn. This is not suitable unchanged for “abort the entire operation and do not restart it.”

The tests intentionally assert these observed limitations, so a green result is **not** a claim that cancellation is correct. Adoption blockers are tracked in `TODO.md`, not implemented here.

## First failure and diagnosis

The first harness run failed before any scenario work:

```text
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
Stripping types is currently unsupported for files under node_modules
.../@gotgenes/pi-subagents/src/service/service.ts
```

The original `first-loader-failure.txt` was not recovered into the tracked evidence; the diagnostic excerpt above is retained.

Cause: the package's public export points at TypeScript source; native Node import is the wrong loading boundary. The corrected harness loads `bridge-extension.ts` through Pi's ordinary jiti-backed extension loader and imports the **same public export** there. No dependency patch, timeout increase, assertion relaxation or green-seeking rerun was used. A subsequent trace-label collision in the test logger was corrected before the full suite; it did not affect scheduling or assertions.

## Limits

This is a real-package contract experiment with explicit schedules, not a production feature, browser E2E, or exhaustive deterministic simulation. It does not prove broker OAuth inheritance, operation-ID correlation, restart recovery, resume, late subscription/reload, nested extension-driven execution, or whole-operation abort suppression. Nothing was deployed.
