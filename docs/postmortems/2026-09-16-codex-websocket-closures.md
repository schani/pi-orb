# Codex WebSocket closures shown in transcript

## Finding

The sampled `WebSocket closed 1006` rows are failed OpenAI Codex response streams, not browser-to-pi-orb WebSockets. Pi persisted each as an assistant message with provider `openai-codex`, API `openai-codex-responses`, diagnostic type `provider_transport_failure`, transport `auto`, phase `after_message_stream_start`, and close code `1006`. The history UI renders that stored `errorMessage`; a later successful attempt does not remove the failed record.

Production does not override Pi's transport setting. Only the mock-OpenAI E2E path forces SSE (`apps/orb-runtime/src/pi/agent.ts`). Pi 0.85.1's `auto` policy tries WebSocket first and can fall back to SSE only before streaming starts. A post-stream closure therefore fails that assistant attempt. Pi then retries up to three times with 2/4/8-second delays. Pi 0.80.10 had the same policy, so the 2026-09-05 upgrade did not introduce it. Commit `253d6338ce23bb54607da86b5581e05b8ea2a3e2` began displaying persisted model-response errors on 2026-09-09.

## Transcript sample

Lossless replicated transcripts were read on 2026-09-16. Rates below are failed `provider_transport_failure` attempts divided by all recorded provider attempts in each snapshot; they are not rates per turn or per unit time.

| Orb | Snapshot range (UTC) | Observed rate | Closure and recovery (UTC) |
| --- | --- | ---: | --- |
| `46034f79-31c6-46df-b212-729d0f78633a` | 2026-09-15 23:14:51–2026-09-16 15:58:46 | 1/170 (0.59%) | Attempt `536451a2` closed 8.148 s after starting, at 2026-09-16 15:56:52.410; child attempt `23654b2a` began 2.009 s later and completed with `toolUse`. Three subsequent recorded attempts through 15:58:46 had non-error finishes. The immediately preceding tool result was the requested `/workspace/analysis/lead-scoring/pr-verification/03-score-help.png` host operation. |
| `8f4b614b-2481-41ab-8893-c29c6c8c3f01` | 2026-09-15 18:01:35–2026-09-16 15:59:07 | 1/673 (0.15%) | Attempt `275b92c7` closed 34.708 s after starting, at 2026-09-15 20:02:49.467; child attempt `fe45b470` began 2.019 s later and completed with `toolUse`. The next 576 recorded attempts through 15:59:07 had no error finish. |
| `a43da4ef-dde3-4eb4-bcd4-c5f1381d628d` | 2026-09-16 15:50:01–15:58:21 | 0/16 | No provider transport failure in this active-orb comparator. |
| `b8fac6f2-c92e-4196-85ca-20ba3215b665` | 2026-09-11 03:40:45–2026-09-14 13:52:49 | 1/279 (0.36%) | Historical attempt `af271301` closed at 2026-09-11 05:42:00.699 after 4.747 s; `c30335dd` began 2.029 s later and delivered the answer by 05:42:07.350. |

The three recent active user-work snapshots total 2/859 attempts (0.23%). This does not establish a fleet rate because the sample was selected around reported cases and transcript spans differ.

The browser Cloud Run service currently has a 3,600-second request timeout. These provider failures occurred after 4.747–34.708 seconds, with no 300- or 3,600-second signature. Cloud Run request logging independently shows the browser live request for orb `46034f79-31c6-46df-b212-729d0f78633a` began at 15:56:35.841775, returned WebSocket upgrade status `101`, and lasted 40.509275 s. It therefore remained open across the 15:56:52.410 provider closure and the retry start. This directly rules out the browser leg for that occurrence. No corresponding browser request log was found in the narrow windows around the other two historical occurrences; absence does not identify their browser state.

## Limits

The records prove which transport leg emitted the displayed error, abnormal close code `1006`, post-stream phase, attempt timing, and successful continuation. Code inspection explains why the failed record remains visible and why retry starts near two seconds later.

They do not identify who terminated the provider connection or why. Code `1006` carries no close frame or reason. The selected sample cannot establish an increase, a general error rate, or an OpenAI, network, VM, Node/Undici, credential, payload-size, or Pi defect. Request sizes for the two recent failures were about 1.06 MB and 1.09 MB, but this sample has no matched size distribution and supports no causal inference. No production or authentication change was made during this investigation.
