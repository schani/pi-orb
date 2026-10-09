# Central-Docker checkout rejected by hosting guard

## Evidence

PR57 revision `46c2539`, [Docker run37496267249](https://github.com/schani/pi-orb/actions/runs/37496267249), shard3: central Git resources became ready at admission version0, then `auth-hosting-denied reason=unknown_host` preceded boot failure `checkout_admission_revoked`. Revision `444b95e` repeated the boot error. First logs/artifacts remain preserved in the qualification monitor.

Docker correctly uses `host.docker.internal:<port>` as its configured runtime authority, distinct from the loopback browser authority. The hosting guard recognized only `/runtime/...`; the existing `/api/runtime/initial-checkout` endpoint therefore received403 before bearer/admission checks. The guest classified any403 as checkout revocation. This was not an observed admission-generation race. `/api/runtime/alert` had the same authority mismatch.

## Correction (2026-10-06)

Recognize those two exact paths on the configured runtime authority, after query stripping. No broad `/api` exemption or browser-host alias. Files isolation, exact host/port, bearer, incarnation, discard, manual/sleep Stop and post-read admission checks remain unchanged.

Actual guard/runtime-route regressions fail before the repair. PostgreSQL/PGlite tests pause the pin read explicitly: an unchanged row or state-version-only update succeeds; manual Stop, Stop→Start on the same bearer/incarnation, discard, incarnation replacement and bearer replacement deny. Test setup uses distinct bearer identities and the store's complete discard operation.

Hosting denial events now include the HTTP method and a fixed route label, never raw paths, queries, hosts or credentials. Healthy requests remain silent.

## Limits

Scoped regressions do not replace central-Docker E2E qualification. External fake-provider approval timeouts and the separate upload continuation stall are not explained by this defect.
