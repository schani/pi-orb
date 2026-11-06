# Successful native image capture returned PENDING

2026-11-05, PST. Qualification only.

[First failure](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/55be2793-d9e4-48c3-8574-6a2f84ddf39e/evidence/q87/native-image-first-failure.md): successful image creation returned valid owned PENDING; the READY-only parser rejected it before validation.
Why Google returned PENDING remains unproven.

The minimal fix reuses existing bounded recovery: 12 reads, 60 seconds, READY-only completion.
Fence the same numeric create ID before the first describe; retain name, source disk, operation and version checks throughout. Never issue a second insert.
Tests first; 226 native tests including DST, typecheck and lint passed. [CI](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/55be2793-d9e4-48c3-8574-6a2f84ddf39e/evidence/q87/native-ci.md): all 10 checks green on `671343ba`.
[Fresh-image PASS](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/55be2793-d9e4-48c3-8574-6a2f84ddf39e/evidence/q87/native-image-accepted.md) qualified clean source `2d5c8e3c`; both live responses were READY, so PENDING recovery coverage is deterministic unit testing.

Exact ownership-fenced cleanup verified all owned resources, processes, keys and SSH cache entries absent; unrelated entries preserved.
No production apply/deployment. VM reboot/stop-start, retained full-image replacement and rollback remain unqualified; release gates: `TODO.md`.
