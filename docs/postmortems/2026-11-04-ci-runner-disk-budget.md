# Hosted runner disk budget (2026-11-04, PST)

## Evidence

[PR 242 E2E 41863172679](https://github.com/schani/pi-orb/actions/runs/41863172679), source `81dcf9b6`, failed before tests in [shard 2](https://github.com/schani/pi-orb/actions/runs/41863172679/job/126690361041) and [shard 4](https://github.com/schani/pi-orb/actions/runs/41863172679/job/126690361428). The unchanged guard required 15 GiB. AWS hosts reported a 72 GiB `/dev/mapper/cow-root` filesystem, about 63 GiB used and 9.6/9.2 GiB available. Docker reported zero containers, volumes or build cache; its six images occupied only 2.154 GB. Image pruning alone could not supply the missing headroom.

[PR 245 control-plane image job](https://github.com/schani/pi-orb/actions/runs/41864648331/job/126695628819) also failed its unchanged 15 GiB guard before Docker build or npm: AWS, 72 GiB total, 14 GiB available. The failure is not specific to browser installation.

The prior [main E2E 41750996444](https://github.com/schani/pi-orb/actions/runs/41750996444) passed all four shards. Passing larger Azure hosts does not qualify the smaller AWS hosts. Neither failed guard ran application tests or DST. Both E2E trace artifacts contain the same 19 tracked historical fixtures, byte-identical to the checkout; they are not new DST failures.

First logs, job/run API responses and trace archives are retained in ignored `.context/ci-runner-disk/first-failure/`. The E2E host advertised Ubuntu image `20261018.96.1`; its linked runner-images tag was unavailable when investigated. Do not infer its exact Android size from today's inventory.

## Cause and decision

**Decision (2026-11-04):** Docker qualification prepares capacity explicitly on ephemeral GitHub-hosted Ubuntu 24.04 jobs. Before setup/downloads, remove only the unused preinstalled Android root, `/usr/local/lib/android`. E2E and the isolated control-plane image job require Node, Python, native build tools, browsers and Docker, not the host Android SDK/NDKs. No image/cache pruning, package-manager removal, production image or deployment change is needed.

Official sources:

- [GitHub-hosted runner capacity](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists 14 GB SSD for standard Linux runners; spare capacity above our 15 GiB assertion is not a platform guarantee.
- [Pinned Ubuntu 24.04 inventory](https://github.com/actions/runner-images/blob/9df30d63b790ea2057d1f50295a8f8a9a303bd88/images/ubuntu/Ubuntu2404-Readme.md) lists Android SDK/build tools/platforms and three NDKs.
- [Pinned installer](https://github.com/actions/runner-images/blob/9df30d63b790ea2057d1f50295a8f8a9a303bd88/images/ubuntu/scripts/build/install-android-sdk.sh) defines that exact Android root.

The defect is the job's uncontrolled initial-capacity assumption. Cleanup is confined to the job-owned hosted VM and fixed unused tool root. Unsupported hosts fail closed. Before/after filesystem and Android allocation diagnostics go to Actions logs and the step summary. Existing post-install/pre-build 15 GiB assertions and job/build deadlines remain authoritative: insufficient recovery still fails, rather than hiding a capacity failure behind a test timeout.

Qualification status is recorded in `docs/testing.md`; outstanding work lives in `TODO.md`.
