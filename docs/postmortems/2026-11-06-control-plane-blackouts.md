# Control-plane blackouts

2026-11-06; times UTC. Service `pi-orb-issuer`, min/max one instance, 2 vCPU, 4 GiB, no liveness probe. Three separate interruptions.

| Window | Duration | Logged responses | Trigger |
| --- | --- | --- | --- |
| 16:35:23–16:42:32 | ~7 min | 563 ingress 429s; process alive | Cloud Run stopped routing; reason unknown |
| 18:52:05–18:52:16 | 11 s | one 503 | Uncaught `AbortError` killed Node |
| 19:16:08–19:17:50 | 102 s | eleven ingress 429s, then no request entries | Both instances received SIGTERM; reason unknown |

## 19:16: no instance

Cloud Run started `22d912e4` (`MANUAL_OR_CUSTOMER_MIN_INSTANCE`) at 19:14:20 beside healthy `dbf9e002`. `dbf9e002` logged `control-plane-shutdown` at 19:16:07.574 and `22d912e4` at 19:16:11.146; both drained cleanly by 19:16:17. The last successful request was 19:16:07.637. No instance existed until `93c4a58f` started at 19:17:43 and listened at 19:17:58; the first logged success was 19:17:50.

## 16:35: instance alive, unrouted

`dcf85c80` kept running its loops at the normal rate, with CPU p99 at or below 0.19, while every request received an immediate 429 "waiting too long for an available instance". Its active concurrency dropped to one. Successes resumed when Cloud Run sent SIGTERM at 16:42:19 and started `3c1a053c`.

The first 429 followed orb `51d3e500`'s `preview-streams-terminated` by 166 ms. That event occurred 21 times in seven days, with no other outage, so this does not establish a cause.

## Ruled out, and limits

No deploy was running. Cloud Audit shows no service update or system event near either window. Memory stayed near 25% and CPU near 40%. The SIGTERMs were not process crashes. Google's public incident feed lists nothing after 2026-10-20, which is weak evidence.

Cloud Run does not log why it replaces or unroutes an instance. Platform attribution is an inference from these exclusions. Min/max one instance is why either event removes all service: it is a contributing condition, not a proven cause.

No 5xx was logged during either blackout. The owner reported 500s around 19:16; they are not in the request logs and remain unexplained.

## 18:52: process crash

```
DOMException [AbortError]: This operation was aborted
    at Object.cancel (chord/dist/context/index.js:83:40)
    at subagents.ts:249:13
    at async waitStatus (subagents.ts:287:18)
```

It is the only fatal stack in seven days; `apps/control-plane/src/main.ts` has no `unhandledRejection` handler, so Node exits by default. Line 249 is `local.cancel()` in `waitForChild`.

`Scheduler.waitForTask` registers on the Session line and returns `{ promise }`. A context cancelled while the job waits for the line reaches `Waiters.add` already aborted, which creates a rejected promise. Delivery then waits for earlier commits to publish, so the rejection has no handler across a macrotask and Node exits.

`apps/control-plane/src/adapters/durable/wait-cancellation.test.ts` reproduces this exception with the real `Harness` and a held commit. Correction: `Waiters.add` marks that rejection handled (`patches/pi-durable.PROVENANCE.md`); callers still receive it. What cancelled the wait at 18:52 was not logged; a steer already in the parent inbox would do it, but that remains unconfirmed.

Gap work: `TODO.md`.
