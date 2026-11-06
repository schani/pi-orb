# Preview reloads failed with spurious 503 (2026-11-05)

## Symptom

A Vite dev page on orb `925b68e5` stopped booting on reload. Its HAR had 187 requests: 152
HTTP 304, 32 HTTP 200, one WebSocket 101 and two HTTP 503. The 503s hit
`/src/components/Icons.tsx` (16:56:41.628 UTC, 3,248 ms) and
`/src/components/ProjectInstructions.tsx` (16:56:42.229 UTC, 2,118 ms) and returned the
gateway's 181-byte JSON error. `App.tsx` imports `Icons.tsx` statically, so one 503 stopped the
application. Cloud Logging recorded nine `preview-admission-denied reason=stale_target` edges
for that running orb between 16:35 and 16:56 UTC, each followed by recovery. Orb `4e11fb98`
showed three more after a restart; each denied request took about 2 seconds.

## Cause

Every preview request and WebSocket upgrade validated compute identity with its own GCE
instance observation and runtime health call, each under a 2-second deadline. A reload of
~200 modules therefore made ~400 external calls inside the control plane at once. Any call
that missed its deadline denied the request as `stale_target` (503). A reproduction of eight
bursts of 200 HTTP/2 requests against a healthy orb gave two 503s and a p50 of 3.0–3.5 s per
request. GCE's own server time stayed under 0.9 s for 180 parallel calls, so the
amplification, not GCE, caused the delays. The denied edge recorded only `reason`, so which
call missed its deadline is not established.

## Fix

Each control-plane process validates compute identity once per orb and shares the result
with concurrent requests for 5 seconds. The authority read and lease stay per request. Orb
state changes and a runtime `stale_target` refusal discard the shared identity. A stale
identity fails closed because the runtime verifies the exact signed target.
`preview-admission-denied` now records `check`, `failure` and `elapsedMs`. DST tests cover
burst sharing, transitions, uncached failures, TTL expiry and refusal invalidation. Live
verification is in `TODO.md`.

## Rule

Per-request admission must not fan out to external services; validate shared facts once and
rely on the downstream fence for staleness. A denial edge must name the check that failed.
