# Consolidation rejected Docker broker callbacks

## Impact

Pre-deployment Docker E2E failed three full-slice scenarios. No production change occurred. A starting orb failed with `boot_context_unavailable: ... malformed response`; the control plane logged `auth-hosting-denied reason=unknown_host` before the runtime handler ran.

## Cause

Consolidation introduced explicit app/files Host allowlists. Local Docker runtimes contact the control plane through `host.docker.internal:<port>`, while the browser origin is `127.0.0.1:<port>`. The host guard omitted that broker authority and returned its denial envelope instead of allowing runtime bearer authentication. Process-backed tests used the browser authority or an explicitly rewriting proxy, so they did not exercise this boundary.

The complete unit suite and signed-Google browser/full-main process tests had passed. Those results did not qualify the Docker callback path.

## Rule and correction

The configured broker authority is accepted only for `/runtime/*`. It does not become a browser API, login or hosted-file alias. Runtime incarnation bearers remain mandatory. App/files origins remain isolated; cloud configuration must not implicitly trust Docker's local alias.

Regression tests first reproduce the default Docker authority and pin path restriction, unknown-host rejection, custom broker configuration and files-origin separation. Use the provider's existing broker address rather than invent another endpoint contract. Full Docker E2E qualifies the resulting boot and lifecycle path; focused policy tests alone are insufficient.

## Evidence

- `.context/consolidation/e2e-docker-host-failure.log`: original runtime failures, control-plane denial edges and diagnostics. Three full-slice failures and one passing clone-failure scenario were recorded.
- The remaining E2E run was deliberately interrupted after the cause was established. Its exit 130 is cancellation, not the original failure; owned orphan worker/control-plane/browser/runtime processes were stopped before further tests.
- `.context/consolidation/test-first-complete.log`: an earlier, separate fixture failure. A hosting unit fixture omitted the now-explicit trusted-local policy. Its expected 403 became a runtime-authentication 401. The fixture was corrected without weakening the assertion; the subsequent complete unit/infra suite passed.
- Final qualification is recorded in `docs/testing.md`.

No timeout was increased and no passing rerun was used to dismiss either failure.
