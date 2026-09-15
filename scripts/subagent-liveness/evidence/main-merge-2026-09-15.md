# Main integration qualification — 2026-09-15

The user requested pushing all pi-orb changes to `main`, not deployment. Merge parents are `3961c1f` (subagent integration) and `0c6f35e` (main). No history is rewritten; the original fork pin/artifact and independent upstream proposal branches are unchanged.

## Integration

- Preserve main's model/thinking controls, personal instructions, orb-view fleet Find and project-header gutters alongside N1/C2/P1 and the flat roster.
- Merge both settings and child-roster synchronization/reset paths. Preserve child-only inbox turn delivery with the existing aggregate operation identity, while honoring settings and cancellation admission guards.
- Settings ownership declines idle-stop/archive preparation; prepared runtimes reject settings. Child admission also rejects during configuration, preventing a child completion from starting root inference on partially applied settings.
- Parallel branches assigned question numbers 62/63 to different topics. Preserve all original numbers and qualify those references by topic rather than renumbering published decisions.

## Tests first and qualification

`apps/orb-runtime/src/pi/settings-idle-stop.dst.test.ts` forces both fence admission orders and child admission during settings persistence, with 30 schedules per order. Settings do not retain an operation/rail.

The first two red cases exposed both missing fence checks. An assertion inside the fake settings adapter also threw outside its typed Result contract, producing unhandled-rejection diagnostics. Both original traces were replayed before correcting that fixture: observations are now asserted outside the adapter. The corrected red cases again failed and were explicitly replayed before the production fix; both then passed their saved traces. The later child-admission assertion failed separately, reproduced on its saved trace, and passed that same trace after adding the configuration guard. No assertion or deadline was weakened.

| Validation | Result |
| --- | --- |
| `npm ci` | Passed |
| Initial and final `npm test` | 235 files / 1,746 tests passed; three files / five existing skips; infrastructure suites passed, including 26 native guest tests |
| Final typecheck / lint / artifact guard | Passed; lint retains four warnings and one informational finding |
| Full `PI_ORB_E2E_BACKEND=process npm run test:e2e` | 10 files / 61 tests passed; two expected platform skips (Docker interrupted-turn and network PostgreSQL) |
| After the final child-admission predicate: subagent and agent-settings frontend E2E | Two files / three tests passed, including Chromium and WebKit |

The full process suite ran on frozen runtime source before the final one-condition child guard; the final unit/infra, typecheck/lint, saved child-regression replay and focused E2E ran afterwards. All four full-slice scenarios passed in process mode. This does **not** repair or qualify the previously failed Docker image store, explain the original WebKit compositor crash, or establish native/cloud/everyday-use acceptance. Existing release gates remain in `TODO.md`. No production workflow was dispatched, and no user preview or orb was restarted.

## Preserved evidence

[Download the checksum-indexed archive](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/main-merge-evidence.tar.gz)

- 55 byte-verified files; **36,712 bytes**.
- SHA-256: `cf7bc6ba85b5013bbf6e4bc378fdcb9cf4cdee32bb043bc303badb9ccd4961df`.
- `manifest.json` records individual hashes, merge parents and final changed-source hashes. Includes synthetic check logs, original/revised red traces and explicit replay results; excludes user histories, credentials and browser cores.
- Corrected fence traces: `test-failures/settings-idle-stop-false-1789489914010-0.json` and `test-failures/settings-idle-stop-true-1789489914018-0.json`.
- Child-admission trace: `test-failures/settings-idle-stop-false-1789490457261-0.json`.

Replay the child regression after extracting the archive:

```sh
DST_REPLAY=<extracted>/test-failures/settings-idle-stop-false-1789490457261-0.json \
  npx vitest run apps/orb-runtime/src/pi/settings-idle-stop.dst.test.ts -t 'stop first=false'
```
