# Vitest worker RPC deadline reproducer

The 2026-09-26 unit failure did not identify its stalled task. These runs used Node v24.6.0; other Node versions may behave differently, so an unexpected result is not automatic proof of the mechanism. This reproduces the **worker-side mechanism**, not that historical task identity. In pinned Vitest 3.2.7, the worker starts a 60-second `onTaskUpdate` RPC timer. The coordinator replies while the worker is in a synchronous child process; consecutive Promise-only iteration boundaries prevent the worker from dispatching the reply. A host-loop handoff between completed iterations permits dispatch. Each of four child-process gates lasts ~15.5 seconds (<60 seconds); total work exceeds 60 seconds. The fixture's 90-second test limit is local to this deliberately long diagnostic; it does not change Vitest's RPC timeout or product test configuration.

Runs started 2026-09-26 13:11:31 UTC (`baseline`), 13:10:21 UTC (`handoff`), and 13:17:23 UTC (`actual`). `baseline-trace.json`, `handoff-trace.json`, and `actual-trace.json` are sanitized monotonic offsets from the target RPC send, with process IDs and random RPC IDs omitted. The corresponding original logs and full traces remain at `/workspace/vitest-timeout-investigation/{deadline2,control2,actual-runDst}/`. `baseline` passed its test but Vitest exited 1 with `[vitest-worker]: Timeout calling "onTaskUpdate"`; `handoff` and `actual` passed and exited 0. Actual-helper run used `runDst({ iterations: 4 })`, whose implementation SHA-256 was `64f2624a351516495a708675c23d4509bc3440f79b843dfeeb34cf98b8590857`; pre-fix source SHA-256 was `ec5d3c59cce700904c1efd9f7497fe8de97e4566d11de4513b70600b00987c2e`. Dependency lock SHA-256 was `bd2fa6ee5642fda61cbcd7e30f820538dda2412b1b16ac3230636c22f0325a82`. Temporary instrumentation was restored: clean chunk hashes `207b5394beb3d4599bae86b4921a28b3a7a9cb6c3266286ea822bd8d1cb39830` and `37b63dd27952c9779fb1cbcd962cf111147a0c42663f3df83dd8094409ff6500` (see patch paths).

## Replay (opt-in; disposable checkout only)

Run from the repository root, with exclusive ownership of `node_modules`; use a fresh checkout and `npm ci`. The patch targets **only Vitest 3.2.7** and does not touch source. Never leave it installed for other tests. Create a fresh evidence directory for each mode (the controller refuses to reuse a directory). `fixture.mjs` is excluded from ordinary `npm test` discovery and selected only by this diagnostic config. The controller exits 0 only when its mode's outcome is verified; in `baseline`, Vitest itself must exit 1 with the exact RPC error while the controller exits 0. Unexpected outcomes cause controller exit 1 after saving traces. On failure, the controller releases all gates, kills only its owned POSIX Vitest process group, and waits for the direct child to close. This diagnostic does not support Windows. In a shell that supports `trap`:

```bash
set -e
npm ci
chunks=node_modules/vitest/dist/chunks
patch_file="$PWD/scripts/vitest-rpc-repro/instrumentation.patch"
patch --dry-run -d "$chunks" -p0 < "$patch_file"
patch -d "$chunks" -p0 < "$patch_file"
trap 'patch -R -d "$chunks" -p0 < "$patch_file"' EXIT
node scripts/vitest-rpc-repro/controller.mjs actual "$PWD/actual-evidence"
# Optional controls, each takes ~62 seconds; controller validates outcomes.
node scripts/vitest-rpc-repro/controller.mjs handoff "$PWD/handoff-evidence"
node scripts/vitest-rpc-repro/controller.mjs baseline "$PWD/baseline-evidence"
```

Exit this shell to reverse the patch before any other checks. Inspect `summary.json`, `events.jsonl`, and `vitest.log` in each evidence directory. If interrupted without trap cleanup, run `patch -R -d node_modules/vitest/dist/chunks -p0 < scripts/vitest-rpc-repro/instrumentation.patch` before any other test; `npm ci` restores a clean dependency tree. Do not write evidence inside the checkout if reproducibility requires a clean `git status`: pass absolute paths outside it instead.
