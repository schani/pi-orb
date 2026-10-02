# Subagent package / Pi runtime contracts

Recovered from orb `b18fc524-632d-42cd-ab90-8b2ac55de80d`, then extended for the production adapter. Local runtime integration pins Pi 0.99.1; historical qualification used 0.87.1. The isolated characterization install pins unmodified gotgenes 21.7.0; evidence also retains the original 21.4.2 run. The runtime uses the immutable `vendor/gotgenes-pi-subagents-21.7.0-orb.5.tgz` fork plus the narrow `patches/@gotgenes+pi-subagents+21.7.0-orb.5.patch` child-codemode allowlist/reserved-MCP-namespace guard. The vendor artifact is unchanged.

```bash
npm ci
npm ci --prefix scripts/subagent-liveness --ignore-scripts
# Unmodified-package characterization (seven schedules):
npm test --prefix scripts/subagent-liveness
# Installed fork + production PiOrbAgent/extension bridge:
USE_RUNTIME=1 npm test --prefix scripts/subagent-liveness
```

Runtime mode imports Pi through `apps/orb-runtime/src/testkit/pi-sdk.ts`, so installing the separate characterization tree cannot shadow production's SDK; a class-identity assertion guards that boundary.

The latter is also required by the ordinary repository suite through `apps/orb-runtime/src/pi/subagent-sdk.contract.test.ts`. Node 24 is required. No model credentials or network inference are used here: each scenario owns a process, temporary HOME/cwd/configuration and scripted in-process model, while the real SDK creates/prompts/disposes child sessions and persists root outcomes.

## Schedules

- `parent-first`: parent settles while a silent child tool remains blocked; one busy period includes child cleanup and root continuation.
- `child-first`: terminal notification is withheld until parent settlement; root `isIdle` is already false when the SDK subscriber sees that settlement.
- `queued`: two children, concurrency one; queue-to-execution handoff never flickers idle.
- `cancel-running`: upstream status/drain APIs finish before cleanup. Runtime-mode whole-operation abort remains busy through cleanup and suppresses root inference.
- `cancel-starting`: the unmodified-package test characterizes the startup cancellation bug. Runtime mode instead requires **zero child model/tool work** after cancellation during workspace acquisition.
- `cancel-queued`: queued cancellation never runs that child's tool.
- `spawn-failure`: workspace preparation fails, with a persisted terminal error and no child execution.
- `resume-cancel` (runtime only): resume a finished child within a new operation, then cancel while its tool is gated; a fresh signal reaches the tool, ownership drains honestly, and no root wake follows.

- `credential-refresh` (runtime only): expire the shared broker-only auth store after root settlement and before child construction; the independent child runtime refreshes through the inherited production broker provider and uses the new grant.
- `credential-failure` (runtime only): reject that child refresh with `auth_required`; a durable error reaches the parent without child inference or tool execution, and credentials do not enter root history.
- `shutdown-running` (runtime only): shut down while a child tool is blocked; whole-operation cancellation reaches it, teardown waits for cleanup, the outcome persists, and no parent inference is resurrected. One explicit event-loop boundary drains the scripted SDK's microtasks while the cleanup gate remains closed; it is not a timed grace period.

- `inbox-child-only` (runtime only): deliver and deduplicate a real inbox message while only the child is working; hold that new root turn while the child completes, then permit the withheld completion wake. Submission acceptance and completion promises are observed separately, retaining one operation and one summary.

- `mcp`, `mcp-shutdown`, `mcp-profile` (runtime only): native root/child MCP sessions use independent clients with the same approved catalog, no duplicated root hooks; cancel/drain before root cleanup; honor a profile excluding MCP, including nested codemode calls. These use an embedding process cwd different from the checkout.

- `idle-stop` (runtime only): preparation rejects late child work and an SDK-originated root prompt before any extra model invocation.
- `mcp-load-failure` (runtime only): a newly discovered `.ts` extension collides with an approved native MCP namespace; the child fails visibly before inference or connection acquisition. Supplying host `childExtensions` opts into coherent loading; upstream's default policy remains unchanged without that option.

Runtime scenarios also assert durable start edges, inherited file-discovered tools, absence of root orchestration tools in children, and one invocation of the root-inline lifecycle sentinel.

Promises and explicit model/tool/lifecycle checkpoints establish ordering; the 60-second timeout is only a deadlock watchdog. Traces survive failure, including watchdog teardown. The microtask bridge is a **pinned source/SDK ordering contract**, not a grace period or generic promise-drain API. No private manager state or run promises determine host activity.

## Fork reproduction

The upstream base is `b3b6159399f541fd0623f65818557dd3e707a34f` (21.7.0). The fork owns the source commits; pi-orb keeps the installed artifact rather than duplicate patches. The source pin is [`1658ccb15a1c6cc8e88c9d16181910b111001964`](https://github.com/schani/pi-packages/commit/1658ccb15a1c6cc8e88c9d16181910b111001964), published on `pi-orb-integration`. From a fresh pi-orb checkout:

```bash
npm ci
git clone https://github.com/schani/pi-packages.git .context/pi-packages-fork
git -C .context/pi-packages-fork checkout --detach 1658ccb15a1c6cc8e88c9d16181910b111001964
scripts/subagent-liveness/build-fork.sh .context/pi-packages-fork
```

The recipe requires source HEAD `1658ccb15a1c6cc8e88c9d16181910b111001964` and a clean package tree. It copies the installed declaration from root `node_modules`, packages source/license/provenance, and bundles public extension/service entry points with esbuild 0.28.1; dependencies remain external. The TypeBox import maps to the SDK's `typebox` package. The root lockfile records artifact integrity. The vendored artifact installs without a fork checkout.

## Evidence limits

See `docs/subagents.md`, `results.md`, and `evidence/README.md`. Generated logs and full scheduler traces are retained in the authenticated, checksum-indexed archive linked there; only concise ledgers stay in the source tree. Original passing characterization traces do not establish cancellation correctness. The first runtime-labeled run did not forward `USE_RUNTIME`; `runtime-sdk-wired.txt` is the corrected seven-scenario production-bridge evidence. Current contracts add resume, broker refresh/failure, awaited shutdown, child-only inbox/wake arbitration and approved MCP/profile/cwd boundaries, SDK-originated admission after idle preparation, and fail-fast child resource collisions (the historical matrix had seventeen installed-SDK schedules; the native cutover adds child-profile contracts). Authenticated foreground child MCP additionally runs in `e2e/mcp.e2e.test.ts`.

Separate runtime/ledger and composed control-plane `determined` tests explore scheduling. `e2e/subagents.e2e.test.ts` uses the actual process provider, browser, installed fork and broker-backed mock inference with named-pipe gates: shared-file editing, child-only busy, reload, continuation, abort, crash/interruption across two restarts, private-child-text exclusion and archive cleanup with retained history. That E2E first found missing child OAuth credentials: inheriting provider registration without using the same private auth path was insufficient. Native/cloud qualification and the remaining acceptance matrix are not implied by these local tests; outstanding work lives only in `TODO.md`.
