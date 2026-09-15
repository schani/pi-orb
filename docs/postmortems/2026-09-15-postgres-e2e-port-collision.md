# PostgreSQL E2E host-port collision — 2026-09-15

GitHub E2E run [35021851799](https://github.com/schani/pi-orb/actions/runs/35021851799)
on `3eec79a` passed all 34 frontend-session cases, including the corrected Find
schedule, and 62 tests overall. The PostgreSQL store suite failed in setup;
its 55 cases were unrun. The run is failed, not a complete E2E pass.

At 21:14:14 UTC Docker reported:

```text
failed to bind host port for 127.0.0.1:55434:172.17.0.2:5432/tcp: address already in use
```

The named container was `pi-orb-e2e-store-pg`; the stack reports
`e2e/harness.ts:64`, propagating the Docker command error. Source inspection
shows `e2e/postgres-store.e2e.test.ts` hard-codes container name and host port
`55_434`. Removing the fixed container name before startup does not establish
ownership of its requested host port. The original runner did not record socket
ownership, so the occupying process/container is not identified. No claim is
made that a particular earlier test leaked it.

The GitHub log is primary evidence; a local copy is
`.context/find-navigation/github-e2e-failed.log`. No rerun, timeout change,
assertion change or resource deletion was attempted to clear this failure.

The test harness must own its container identity and port allocation rather than
assuming a fixed port is free or deleting whatever owns it. Correction and
collision-focused verification are tracked in `TODO.md`. Production was not
changed. This is separate from the repaired Find synchronization issue and the
still-unresolved WebKit crash.
