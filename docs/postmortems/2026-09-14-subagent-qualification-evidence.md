# Subagent qualification evidence archives (2026-09-14/15)

Index of the downloadable PR 44 subagent evidence, moved from the former `scripts/subagent-liveness/evidence/` ledgers. The ledgers themselves remain in Git history (last at `45882b74`). Archive members keep their original repository-relative paths, so references such as `scripts/subagent-liveness/evidence/final-idle-stop-first.json` in other postmortems name archive members, not tracked files. All archives require pi-orb authentication.

| Archive | SHA-256 | Contents |
| --- | --- | --- |
| [subagent-evidence.tar.gz](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/subagent-evidence.tar.gz) | `fb8373036b339553553094efb172e05ef2abb004ccf7c436c8d43b561183087c` | 59 formerly tracked logs/traces (integration, continuation, final qualification); `manifest.json` maps members to original paths. Source commit `c0e4156d3b88c2b669ccc56ac41282c1a00c3c0e`. |
| [live-rail-evidence.tar.gz](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/live-rail-evidence.tar.gz) | `7fd9946d4d77d72a70206a4dee113414b61722aa865c615049116bb68b6eacfd` | N1/C2/P1 live rail, terminal and notification validation, including the Docker export failure (`docs/postmortems/2026-09-15-docker-snapshot-validation-failure.md`). |
| [flat-roster-evidence.tar.gz](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/flat-roster-evidence.tar.gz) | `5e14eb406b8fdd8edf5894a85f7cdf64eb8add4e4c7628e986769b9c7074a926` | Roster correction logs, including first failures. |
| [main-merge-evidence.tar.gz](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/main-merge-evidence.tar.gz) | `cf7bc6ba85b5013bbf6e4bc378fdcb9cf4cdee32bb043bc303badb9ccd4961df` | 2026-09-15 main integration: settings/fence and child-admission regressions and replays. |
| [upstream-split-evidence.tar.gz](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/upstream-split-evidence.tar.gz) | `4d14aab8aba3b5633d66e9a59c61413dcea01fa0f844502a7cd266df80b56d3b` | Four independent upstream `gotgenes/pi-packages` draft branches and their package qualification. |

Verify and extract outside the checkout, then replay from the repository root:

```bash
printf '%s  %s\n' fb8373036b339553553094efb172e05ef2abb004ccf7c436c8d43b561183087c subagent-evidence.tar.gz | sha256sum -c -
evidence=$(mktemp -d)
tar -xzf subagent-evidence.tar.gz -C "$evidence"
npm ci
DST_REPLAY="$evidence/scripts/subagent-liveness/evidence/archive-compute-timeout-first.json" \
  npx vitest run apps/control-plane/src/domain/orb-archival.dst.test.ts -t 'late timers: true'
```

Older traces capture pre-repair schedules; replay them against the historical revisions they were recorded on. The archives do not replace executable regressions or clear any release gate.
