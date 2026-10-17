# Usage mock idle connection (2026-10-16)

[PR 137](https://github.com/schani/pi-orb/pull/137), source `ca752b1d`: [first failure](https://github.com/schani/pi-orb/actions/runs/38982221074/job/117245450821), line 409, was the second direct usage GET's `read ECONNRESET` after charts, intentional 503 and five rows passed. The URL belonged to the in-process Vite mock, not the control-plane child; no new DST trace.
An earlier 42s WebKit diagnostic did not reproduce: ordinary 6s idle expiry closed the first socket, and the final GET used a new socket successfully. This does not clear the failure.
One controlled A/B pair used installed Playwright APIRequestContext and public Node HTTP APIs. At the second client socket assignment, both arms invoked server.closeIdleConnections().
A: default keepalive reused the first socket; GET two never reached the server and failed ECONNRESET (`socket hang up`). B: only response `Connection: close` differed; GET two assigned a new socket and returned 200. Both contexts, servers and tracked sockets closed under the shared validation lock.
This proves an uncontrolled stale-idle-lease class, not CI's unique cause: its exact `read ECONNRESET` differs. CI's first reset occurred at 6742ms; server idle settings were 5000ms + 1000ms, with no client idle eviction/retry. The historical close owner remains unknown; retained first-failure logs/artifacts are not replaced by passing runs.

Decision: close only the owned usage mock's HTTP/1 responses, including query errors, rather than add retry machinery. Status/body and all original UI assertions remain unchanged; the first successful GET checks resource ownership.
Tests-first: WebKit rejects the old `keep-alive` header; after the header change, both original browser cases, E2E typecheck and scoped lint pass. No production API or persisted state changes.
PR 137's original 10/11 checks do not qualify it: this separate correction must land, then its integrated new head must pass full CI. New failures retain normal investigation/replay requirements; the existing harness-icons deployment blocker remains unchanged. No deployment authorization.
