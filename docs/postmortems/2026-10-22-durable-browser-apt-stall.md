# Durable browser dependency acquisition stall — 2026-10-22

[Durable qualification 39829879072](https://github.com/schani/pi-orb/actions/runs/39829879072), attempt 1 on PR 158 source `978c1cfd25949519c3bd90466ecb39805e2c1006`, was diagnostically cancelled, not rerun. Process [shard 1](https://github.com/schani/pi-orb/actions/runs/39829879072/job/120002882984) and [shard 2](https://github.com/schani/pi-orb/actions/runs/39829879072/job/120002882894) never reached tests. Shards 3/4 and the image job passed; that is not complete qualification.

## Evidence and limits

Terminal logs prove the phase: `playwright install --with-deps chromium webkit` began at 11:17:12/11:17:34 AM PDT and remained in Ubuntu `.deb` acquisition until cancellation at 11:43 AM, over 25 minutes later. `Get`/`Ign` lines identify `http://azure.archive.ubuntu.com/ubuntu`, including `libcodec2-1.2` acquisition followed by `Ign`; the final package lines precede cancellation. This is not a test timeout. Logs do not distinguish mirror service, intermediary/network or runner behavior; no historical root cause or fix is claimed.

Retained evidence under `.context/bun-git-crypt/`:

- `run39829879072-terminal-logs.zip` and extracted `run39829879072-terminal-logs/{1_Central process (1_4),3_Central process (2_4)}.txt`.
- ZIP SHA-256: `11eb0c22c53c97e04d2198a4c1f940b6fe4f816b56b8a0b55d9d8cdd52a8e451` (`run39829879072-terminal-logs.zip.sha256`).
- `run39829879072-{before-cancel-20261022T184228Z,after-cancel,jobs-after-cancel}.json` plus cancellation request/response records; cancellation requested at 11:42:28 AM PDT.

## Correction

**Decision, 2026-10-22:** extend existing signed Ubuntu archive/IPv4 helper coverage to `durable-qualification/process` before its first APT operation, including Playwright's privileged child. The omitted workflow used the runner mirror list while checks, Docker E2E and release already used `infra/runner_apt.py`. Reuse that helper unchanged; its URI/keyring/IPv4 diagnostics persist in Actions logs. Preserve signature/hash verification and all retry/timeout/test policies. No new persisted application state, fallback, generic retry or assertion change.

Tests first: adding Durable process to the existing workflow-order inventory failed `0 != 1` for its absent helper invocation (`durable-apt-red.log`). Only then was the helper step added. The 34 runner APT/qualification contracts, full `npm run test:infra`, root typecheck/lint and `git diff --check` pass; lint reports warnings/info, no errors. Logs: `durable-apt-{green,infra,typecheck,lint}.log` in the same evidence directory. The retained ZIP checksum verifies. No new DST failure occurred. Local contracts cannot establish hosted recovery; fresh exact-head attempt-1 CI/E2E/Durable gates remain mandatory. No workflow rerun, merge or deployment is part of this correction.
