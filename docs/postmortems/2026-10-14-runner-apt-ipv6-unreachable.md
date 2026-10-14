# Hosted runner APT IPv6 unreachable — 2026-10-14

## Evidence

[E2E 38579888332](https://github.com/schani/pi-orb/actions/runs/38579888332), attempt 1, exact main `adc9cc62b297a7fcb6a30c9466376b3d196a812e`, failed in [shard 2 job 115906680381](https://github.com/schani/pi-orb/actions/runs/38579888332/job/115906680381). “Use the signed Ubuntu archive” succeeded at 07:22:30 PDT. “Install native addon prerequisites” failed at 07:23:00 PDT, exit 100; dependency installation, Playwright installation and E2E execution were skipped. Shards 1, 3 and 4 succeeded; they do not clear shard 2.

The signed archive index update completed (36.7 MB in 11 seconds). The subsequent `build-essential_12.10ubuntu1_amd64.deb` HTTPS fetch failed. Original log excerpts:

```text
Runner APT URIs: https://archive.ubuntu.com/ubuntu/
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Get:6 https://archive.ubuntu.com/ubuntu noble InRelease [256 kB]
Get:7 https://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]
Get:8 https://archive.ubuntu.com/ubuntu noble-backports InRelease [126 kB]
Get:9 https://archive.ubuntu.com/ubuntu noble-security InRelease [126 kB]
Fetched 36.7 MB in 11s (3381 kB/s)
Err:1 https://archive.ubuntu.com/ubuntu noble/main amd64 build-essential amd64 12.10ubuntu1
  Cannot initiate the connection to archive.ubuntu.com:443 (2620:2d:4000:1::101). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2620:2d:4000:1::103). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2620:2d:4002:1::101). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2620:2d:4002:1::103). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2a06:bc80:0:1000::18). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2a06:bc80:0:1000::17). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2620:2d:4000:1::102). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2a06:bc80:0:1000::16). - connect (101: Network is unreachable) Cannot initiate the connection to archive.ubuntu.com:443 (2620:2d:4002:1::102). - connect (101: Network is unreachable)
E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?
##[error]Process completed with exit code 100.
```

Original run metadata and full shard log are retained locally in `.context/runner-apt-ipv4-38579888332/{run.json,shard2.log}`, with SHA-256 respectively `49384f4fa6c3ccf66c8c7c0740299915dcfc3c96e64718049be19d1c62270b8c` and `25a1c9009905d948d40bd14f90a358466115e790c840859ec80f763a93d75912`. The complete original Actions log archive is retained as `original-logs.zip` in that directory (SHA-256 `4fd93d74d01a02cde26cc433f02d2c97ea684bac193dd1fb3c6057fa28ecaddd`). The original Actions run was not rerun.

## Limitation

The package-fetch diagnostic lists only IPv6 addresses, each with connect errno 101. It does not establish the DNS answer set, an attempted IPv4 connection, why earlier index acquisition succeeded, or the underlying network outage cause. No DNS, runner, archive or provider root cause is claimed. This was prerequisite acquisition, not a test assertion or DST failure.

## Decision — 2026-10-14, PDT

Through `infra/runner_apt.py`, write `Acquire::ForceIPv4 "true";` to the dedicated ephemeral runner drop-in `/etc/apt/apt.conf.d/99pi-orb-force-ipv4` before the first APT operation in Ubuntu CI checks, E2E and Deploy release jobs. System APT configuration also covers Playwright's privileged APT child; per-command flags would not. Preserve the signed HTTPS archive transformation, every other source field and all other configuration files. Log the IPv4 policy alongside the existing URI/keyring diagnostics in Actions.

No signature/hash weakening, retry or timeout increase, production persisted state, Debian image or native GCE provisioning change. No deploy or cloud mutation.

## Validation

Tests were written first: missing IPv4 configuration and workflow wiring produced the expected red result. After implementation, `python3 -m unittest infra/runner_apt_test.py infra/ci_qualification_test.py` passed all 34 tests. Fixtures cover exact source-byte preservation, configuration scope/idempotence, workflow ordering and a real isolated APT child loading the drop-in without CLI flags. `npm ci` preceded checks; `npm run lint` exited 0 with warnings in unchanged files, and `git diff --check` passed. Red/green and lint output are retained beside the original logs.

Offline regression tests do not prove hosted-network recovery. Deployment remains blocked pending fresh attempt-1 exact-head CI, all four E2E shards and Durable qualification; rerunning the failed historical run cannot qualify the corrected source.
