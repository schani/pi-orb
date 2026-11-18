# Rejected WebSocket socket leak

2026-11-17, UTC. Cloud Run service `pi-orb-issuer`, revision `pi-orb-issuer-00102-w5g`.
Public requests began receiving ingress 429s at 23:42:33.530, without reaching Node.
The response said no instance was available. Local `/health` probes continued passing.

## Application defect

Preview authentication hooks run before `@fastify/websocket`'s `onRequest` hook. When auth
returns 401, the plugin never sets `request.ws`. Its `onResponse` cleanup checks that flag
and skips closing the raw upgrade socket. The synthetic `ServerResponse` does not have
Node's normal HTTP connection cleanup. A client disconnect leaves the socket half-open:
`readableEnded=true`, `writableEnded=false`, `destroyed=false`, `allowHalfOpen=true`.
These sockets are absent from `websocketServer.clients`, so accepted-WebSocket cleanup
does not find them.

The [regression test](../../apps/control-plane/src/http/websocket-rejection.test.ts) reproduces
this over real TCP: 401, 403 and redirect responses all leak before the fix. It also checks
accepted WebSocket messages and ordinary HTTP keep-alive.

## Production evidence

The new `control-plane.http` telemetry exposed steadily accumulating upgraded sockets:
1 at 19:49, 102 at 21:29, 201 at 23:09, and 213 during the outage. In a quiet 30-minute
window, every unauthenticated preview admission corresponded to one additional open
upgraded socket: 30 rejections, 30 sockets, exact agreement across all 60 sampling
intervals. The [sanitized samples](2026-11-17-rejected-websocket-leak.csv) retain the
counts and timestamps. Source: Cloud Logging stdout, filtered to this revision and
the original instance (`00e8a408bd55d7e824120d96…`), messages `control-plane.http` and
`preview-auth-admission outcome=unauthenticated`, 22:30:12–23:00:14.

After 23:42:32, non-health HTTP requests stopped reaching Node. Samples showed a listening
server, no ordinary requests in flight, three successful health requests per 30 seconds,
and no server/parser errors. CPU and memory were not exhausted; reported request
concurrency was below the configured 80. File descriptors were approximately 280.

At 23:42:32.916, preview authority revalidation terminated a stream with
`reason=deadline_exceeded`, 615 ms before the first ingress 429. Similar ordering occurred
in an earlier blackout; causality is unproven.

Cloud Run started a replacement instance at 23:48:32 on the same revision. Startup and
liveness probes passed at 23:48:48; the 23:49:18 sample showed 271 public requests and two
upgraded sockets. No deployment or restart was performed during this investigation.
The replacement reason was `MANUAL_OR_CUSTOMER_MIN_INSTANCE`; audit logs showed no
service update. That label does not identify who or what initiated replacement.

## Correction and limits

The application closes rejected upgrade sockets after flushing their response, without
depending on the plugin's auth-hook ordering. The rule lives in `docs/http-exposure.md`.
Existing socket/descriptor telemetry and auth-admission events can verify whether the
leak stops; the new instance was already accumulating sockets before this correction.

The application leak is reproduced and its production signature is matched. Its precise
connection to Cloud Run's admission failure is not established: there is no demonstrated
socket threshold, and local health remained responsive. This evidence does not justify
calling the incident a Cloud Run bug or claiming that the correction alone prevents 429s.
