# WebKit cold-cache readiness assertion (2026-09-16)

Local stage-2 qualification failed; no deployment occurred.

## Evidence

`e2e/transcript-cache-frontend.e2e.test.ts` passed in the full process-backed suite, then failed during a frontend run concurrent with `npm test`. After WebKit reload, `Change thinking` remained disabled with `—` when its five-second assertion expired. The other 79 frontend cases passed.

First log: `/tmp/pi-orb-stage2-ui-final-e2e.log`; SHA-256 `c90e792d945bb5b0d98e6a3384ff7e69fee83ca521bcde86d43dd86401371467`.

Instrumented reproduction under controlled CPU contention established that no post-reload WebSocket frame had reached the browser proxy at failure. The disabled state was correct, not a dropped settings update.

## Cause

Development StrictMode starts two uncancelled 26 MB cold-history reads. Reload-era parsing, rendering, cache sizing and garbage collection delayed the new live handshake beyond an incidental assertion window. The test treated navigation completion as live readiness, despite this scenario not asserting wall-clock performance.

Reproduction used four CPU-affined Python processes, one on each CPU `0–3`, each spinning for 70 ms and sleeping for 30 ms:

```sh
pids=''
for cpu in 0 1 2 3; do
  taskset -c "$cpu" python3 -c 'import time
while True:
 s=time.perf_counter()
 while time.perf_counter()-s < .07: pass
 time.sleep(.03)' &
  pids="$pids $!"
done
trap 'kill $pids 2>/dev/null || true' EXIT
npx vitest run --config e2e/vitest.config.ts \
  e2e/transcript-cache-frontend.e2e.test.ts -t '^webkit:'
```

## Correction

Arm and await the addressed socket's next `agent_settings` frame before asserting the resulting UI state. Keep the payload and assertion timeout unchanged. The same contention reproducer passes after this synchronization change, as do both browser cases without injected contention. No product change was needed.

Cold-history tests synchronize on protocol evidence before checking live controls; navigation completion is not that evidence. Final suite results are in `docs/testing.md`.
