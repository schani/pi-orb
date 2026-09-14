# Local follow-up qualification — 2026-09-14

No production deployment was performed. This supplements the earlier integration/continuation ledgers; their artifact pins and test counts are historical.

## Immutable fork

- Pi **0.85.1**, gotgenes base **21.7.0**, upstream commit `b3b6159399f541fd0623f65818557dd3e707a34f`.
- Published fork: `schani/pi-packages`, `pi-orb-integration`, **`6d333b00670d778812b79bce2dd2e1db3f5f9692`**.
- Five patches: cancellation (`b8dbccdc`), actual-delivery wake veto (`6ad3a281`), explicit child factories (`9b0c61b6`), embedded cwd (`864a2764`), coherent explicit child loading (`6d333b00`).
- Artifact: `vendor/gotgenes-pi-subagents-21.7.0-orb.4.tgz`.
- SHA-256: `08f267e51ba025f410b1ae3875e754f40744d7ead30bde55e54b6ff35a497306`.
- Offline patch application with author-date committer timestamps reproduced the exact published HEAD.
- Fork suite: **80 files / 1,773 tests passed**.

The last fix rejects child loader errors before constructing a model runtime when the host supplies `childExtensions`, including an empty list. Without that option, upstream's default loading behavior is unchanged. The corrected real-SDK collision probe failed against the preserved `orb.3` Docker image (`completed` instead of `error`) and passed against installed `orb.4`, with no child inference or MCP connection acquisition.

Two fixture mistakes were diagnosed rather than counted as product evidence: `.mjs` was not auto-discovered in the extension directory (the authoritative probe uses `.ts`), and the composition-root helper initially read a previous case's mock call (it now clears its own calls). The authoritative before/after logs are `mcp-load-orb3-real-before.log` and `mcp-load-orb4-real-after.log` under the ignored local evidence directory.

## Admission, recovery and destructive boundaries

The final idle-stop and archive snapshot races were forced and explicitly replayed before repair. Checked-in copies, normalized only with a trailing newline:

- `final-idle-stop-first.json`: a newly busy child was stopped after the final drain.
- `final-archive-first.json`: admission after an empty/idle reply lost the active child's workspace.
- `archive-compute-first.json`: an old compute's preparation sealed a replacement.

The shared runtime preparation barrier closes first-party and SDK-originated admission before final drain. Its private lifetime-scoped file survives runtime-only restart even if Pi has not flushed an unused session; uncertain persistence fails readiness and stays closed. Archive keeps pulling while busy preparation is declined and seals only the prepared compute. Busy/error/seal decisions use lifecycle edges and existing error surfaces. Full rationale, including the rejected snapshot-only repair and the caught busy-pull regression, is in `docs/postmortems/2026-09-14-idle-stop-admission-race.md`.

Additional qualification includes sixty before/after idle-stop schedules, thirty final archive schedules, fifty blocked-peer cleanup/abort schedules, sixty uncooperative-child Stop/delete schedules, and real-file failed-append versus committed/lost-ack recovery contracts. These augment, rather than replace, the earlier runtime and composed DST.

## Validation ledger

- `npm ci` completed for the installed artifact.
- Repository suite: **218 files passed / 3 skipped; 1,697 tests passed / 5 skipped**, followed by passing infra checks (including 26 native guest tests).
- All **17 installed-fork/production SDK schedules** are required by that suite.
- Typecheck and lint pass; lint retains the existing warning and informational diagnostic.
- Final combined E2E on implementation commit **`f51c407`**: **10 files / 106 tests passed**, including active-child archival, authenticated child MCP, Docker/PostgreSQL and all frontend browsers. Runtime Docker image: `sha256:5811bcee4f455ddb243c35d72db428d5ace4bacdd04be307b1e8295af10797d9`.
- First fenced-runtime combined E2E: **106 passed**, Docker image `sha256:0a8389246d07f773b1a9dcd969dbdd5bc3cfedd4d67a8f4f016746ac1b9b2608` (historical `orb.3`).
- The `orb.4` combined round passed 105 tests and failed the newly extended active-archive fixture: its one-use ordered model rules put the new delegation before restart rules, then tried to reuse consumed rules. The retained history shows `no_matching_rule`, not a runtime admission failure. The repair orders distinct restart/delegation rules as executed and explicitly waits for the third restart reply; no timeout or product assertion was weakened. The next focused run exposed a real process-provider wiring gap: preparation correctly refused to seal without a lifetime ID. A failing provider-env contract preceded persisted supervisor identity across crash relaunches and fresh identity on Stop/Start. The repaired active-archive browser case passes in **250.3 seconds**, including the explicit busy decline, terminal result/root follow-up retention, and workspace destruction. The full repository/infra suite passes again after that provider fix.

Local raw command logs are under `.context/subagents-finish/`; they are not exported because some inference dumps contain mock authorization headers. Original failure directories and traces are retained.

The original native WebKit compositor SIGSEGV remains unresolved; later passing browser runs do not clear it. An initial read-only cloud preflight could not refresh the configured federated identity because the issuer did not answer within the CLI's ten-second budget (exit 6). A later independent preflight succeeded with the existing federation; no fallback admin login was attempted. Native build/boot qualification was then attempted from clean commit `f51c407`: `us-central1-a` rejected the prescribed `n2d-highmem-4` builder with `STOCKOUT` and advertised other zones. A separate attempt in advertised `us-central1-c` was refused by the existing `compute.instances.create` grant. Both owned cleanup sequences completed; instance, disk and image inventories found no retained qualification resources. No IAM permission was widened, no image was produced, and native/cloud or everyday-use qualification is not claimed. Local logs are `native-qualification.log` and `native-qualification-c.log`. Outstanding gates are tracked only in `TODO.md`.
