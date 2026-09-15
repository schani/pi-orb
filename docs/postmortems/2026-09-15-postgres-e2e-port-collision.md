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

## Investigation requested instead of allocation changes — 2026-09-15

The user requested gathering the cause before changing port allocation. The
original hosted runner was Ubuntu 24.04 image `20260907.300.1`. Its full log
contains no `ss`/`lsof`/socket-owner snapshot. The only uploaded artifact contains
two older committed DST traces, not host networking evidence. The original
occupant cannot be reconstructed from those retained files. E2E file parallelism
is disabled; repository search found the store fixture is the only explicit
55434 binding. The other PostgreSQL fixtures use 5436 and 5437. These facts do
not rule out an ephemeral socket or an unrelated listener.

**Controlled mechanism finding, not attribution:** on this Linux orb,
`ip_local_port_range` is `32768 60999`, and `ip_local_reserved_ports` is empty.
55434 lies inside that range. A deliberately owned client was bound to local
55434, connected to a disposable loopback listener on another port, then actively
closed. Both application descriptors closed, but the kernel retained:

```text
TIME-WAIT 127.0.0.1:55434 127.0.0.1:42847 timer:(timewait,59sec,0) ino:0
```

A new listener using `SO_REUSEADDR` failed with errno 98. A real Docker run of
`postgres:16` under a unique diagnostic container name also exited 125 with
`failed to bind host port 127.0.0.1:55434/tcp: address already in use`. Immediate
inspection still showed only that TIME_WAIT socket on local 55434, not another
listening server. The uniquely owned failed container was removed. This proves
the reported failure can arise from a closed **client** connection and does not
require a leaked PostgreSQL container. It does **not** prove that this was the
original GitHub occupant or that its kernel policy matched this machine.

Experiment source, full socket/PID observations and Docker error are retained in
`.context/port-investigation/client-port-experiment.py`,
`docker-client-port-experiment.py` and their `.log` files. The client port was
explicitly bound to make the mechanism deterministic; no unrelated socket was
closed, and no global port policy was changed.

**Diagnostic instrumentation:** `e2e/port-diagnostics.ts` now captures bounded,
read-only snapshots immediately before the fixture's bind and after Docker run
failure, before cleanup. It records all matching TCP states (including TIME_WAIT),
local/peer endpoints, inode/timer information, process names/PIDs where permitted,
ephemeral/reserved port policy, and Docker ID/name/port/status mappings. Root
socket ownership uses noninteractive `sudo -n`; unsupported or unavailable
probes are recorded explicitly and cannot replace the original test failure.
Process arguments, environments, Docker inspect/configuration and credentials
are not collected. Each command is bounded to three seconds and 256 KB; JSON
`postgres-port-diagnostic` events survive in the GitHub job log. Pure contract
tests cover exact read-only commands and independent unavailable probes; the
real experiment validated ESTABLISHED → TIME_WAIT capture and missing-tool
handling. Port, container name, existing cleanup and test retry policy remain
unchanged while gathering evidence.

## Instrumented hosted run

Diagnostic commit `3e84345` passed CI `35027406844` and E2E
[35027406866](https://github.com/schani/pi-orb/actions/runs/35027406866): 19 files,
131 tests, including all PostgreSQL contracts and the two diagnostic contracts.
At 22:12:04 UTC the before-bind snapshot reported no matching TCP sockets, no
Docker containers, ephemeral range `32768 60999`, and no reserved ports. All
four probes succeeded, including privileged socket inspection. PostgreSQL then
bound successfully. This confirms the exposed ephemeral-port policy on a real
hosted runner, not only the local experiment; it does not identify the original
occupant. There was no run-failed snapshot because this diagnostic execution had
no collision. Its full log is retained locally as
`.context/port-investigation/35027406866.log` and durably in GitHub.

The independently running uninstrumented `d170a4e` E2E run `35025810795` also
passed all 129 tests. Neither successful execution retrospectively explains the
first failure. The fixed allocation and original failure remain preserved.

The test harness must own its allocations, not delete unidentified occupants.
Further attribution is tracked in `TODO.md`. Production was not changed. This is
separate from the repaired Find synchronization issue and the WebKit investigation.
