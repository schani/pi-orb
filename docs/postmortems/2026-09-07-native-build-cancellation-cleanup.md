# Interrupted release left its image builder

**Date:** 2026-09-07  
**Impact:** An interrupted native release left one owned builder VM and its auto-delete boot disk running. Production serving state was unchanged.

The release shell, build wrapper, npm and Node builder all received terminal SIGINT. The release did not track its foreground build child, and npm exited before the Node process's `AbortController` cleanup completed. The log ended after `builder: ready started` and `release: interrupted`; operation evidence contained create/verify calls and no cleanup calls.

The surviving builder carried the exact interrupted operation labels and IDs. An earlier cleanup checked only the later restarted operation instead of inventorying every native-build label. Final inventory found the orphan; its VM and disk were deleted and verified absent.

The release now tracks the build wrapper. The wrapper invokes and tracks the Node builder directly, removing npm from the signal path. Both shell layers handle one termination signal, ignore duplicates, terminate their child and wait. Persistent, idempotent Node handlers abort once. Tests block cleanup after an explicit ready barrier, repeat the signal, and require `cleanup-done` before wrapper exit for process-group SIGINT, SIGTERM and SIGHUP and release-PID-only SIGTERM. Final cleanup must inventory all owned native builder and validator labels, not only the latest operation ID.
