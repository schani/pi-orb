# Local E2E interrupted by incorrect Docker startup and caller lifetime

## Findings (2026-09-09)

After the coding orb restarted, Docker and containerd were inactive. Starting
`dockerd` directly was incorrect: the configured systemd service attaches to
`/run/containerd/containerd.sock`, whose data lives in `/workspace/containerd`.
The manually started daemon instead launched its own containerd under
`/workspace/docker/containerd/daemon`. It reused Docker's persistent BuildKit
metadata against that different snapshot store.

Both Docker-backed E2E suites failed at the same missing parent snapshot,
`mg00svlelxan5hrfkydylt2xa`. This was an operator environment error, not evidence
of a product failure or a flaky assertion. After stopping the owned manual
daemon and starting Docker through systemd, that exact snapshot was independently
confirmed present and committed. No cache pruning, filesystem repair or workspace
removal was used. The subsequent image build completed in approximately 82 seconds.

The next E2E execution was killed by the tool caller's 600-second limit before
Vitest produced a verdict. That limit was shorter than the suite's existing
720-second individual test/hook deadlines, and did not account for the entire
suite. The interrupted execution is not a pass. Its runtime and PostgreSQL
fixtures and private diagnostics were retained. On another runtime restart,
starting Docker automatically restarted the retained runtime container; it was
explicitly stopped again, without deleting its storage.

A fresh validation uses an owned background process with a durable exit-status
file and verbose test progress. Test deadlines are unchanged. The full-slice
PostgreSQL container now has an execution-unique name: its setup must not delete a
previous execution's fixed-name fixture. The fresh validation passed all 65 tests
in 814.34 seconds. This confirms that the earlier 600-second caller budget could
interrupt a healthy full run; no test deadline was increased. The retained runtime
fixture's restart policy was disabled after it was stopped, preventing later daemon
startup from resuming the interrupted workload.

## Operational rules

- In these native coding orbs, start Docker through its configured systemd
  service, not bare `dockerd`; its containerd endpoint and persistence are part
  of the same installation.
- Inspect process/container state after restart. Starting a daemon can restart
  retained containers even when no test runner remains.
- Keep first failures and interrupted fixtures. Do not prune a cache merely to
  obtain green or let new test setup erase earlier evidence.
- A tool-call timeout is not a test verdict. Monitor long validation with owned
  process identity and a durable outcome, respecting existing test deadlines.

Private evidence is in `.context/one-button/`: `e2e-first.log`, Docker startup
logs, `restored-snapshot.json`, `build-history.json`,
`e2e-configured-containerd.log`, and the interrupted-fixture diagnostics.
These directories are not CI upload artifacts.
