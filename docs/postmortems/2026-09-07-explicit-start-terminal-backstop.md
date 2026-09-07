# Explicit Start inherited terminal backoff

**Date:** 2026-09-07  
**Impact:** An E2E Start remained `starting` for 30 seconds. No production deployment occurred.

A restarted control-plane process reconciled a stopped orb before the E2E submitted Start. That terminal pass scheduled the orb's next reconciliation at the 30-second backstop. Start changed durable state to `starting`, but the process retained its local deadline. In production, Start and reconciliation run in separate control-plane roles, so a local wake cannot reach the reconciler. A same-process Start could also lose its wake when an already-running terminal pass wrote its deadline afterward. The expected `spec-replacement-declined` edge arrived at the test's timeout boundary.

Each scheduled deadline records the durable orb version it observed. A scan reconciles immediately when that version changes, including across control-plane processes. Local wake commands also advance a generation, preventing an in-flight stale pass from overwriting the wake without a durable state change. Deterministic dispatcher DSTs cover both interleavings. The first failing E2E log was preserved before the fix.
