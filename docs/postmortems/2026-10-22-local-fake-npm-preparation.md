# Local fake-provider npm preparation failure (2026-10-22)

## Evidence

[Durable run 39844782648](https://github.com/schani/pi-orb/actions/runs/39844782648), central process 1/4, [job 120055086578](https://github.com/schani/pi-orb/actions/runs/39844782648/job/120055086578), tested source `9691ef3ce7ec157bfc9408a1bb59b4ee2b4a378d`. It blocks [Deploy 39845276226](https://github.com/schani/pi-orb/actions/runs/39845276226).

Git init/fetch/checkout/rev-parse and lock-pin validation succeeded. Provider `npm ci --no-audit --no-fund` exited **152** after **12.094s**, 1:00:43.587–1:00:55.681 PM America/Los_Angeles. No service-started, readiness or command-started phase exists: tests never launched. Manifest: `code: 1`, `error: tool_failed`, `cleanupError: null`.

Pinned provider: `eaa274c562ea7b1ec6dce496a1442cfbb55b4106`; flingit `0.0.70`; Node `v24.22.0`; lock SHA-256 `07fbe5a80cc413631d8276eeef1529102c03895b03f547564d640e7b88444b40`.

Downloaded artifacts:

- `local-fake-process-1-39844782648-1`, ID `12454592660`: manifest SHA-256 `8d0df6a09c5968527255bbb5f395bb6325063ca48913d3c00002af31e83852ef`; phases SHA-256 `1dcee74bbdf7b908fb47333ab8fdd89b0bd21a166042011abfdeb3c4f7af2a4a`.
- `central-process-1-39844782648-1`, ID `12453774050`: all 19 JSON files match tracked historical fixtures byte-for-byte; none is a new failure trace.
- Job log SHA-256 `f7410ea45bc51cfaefb56e70c20be20dd669bf9ab1854138e726eebdc6a1ae9e`.

Original downloads, npm exit-handler source, hashes and diagnosis remain in `/tmp/qualification-39844782648/`. Local regression receipts and copied diagnosis/hashes: `.context/local-fake-install/`.

## Cause and attribution limit

**The underlying npm cause is unknown.** The wrapper redirected output into private `tool-*.log` files, returned only failure type/status and uploaded only `manifest.json`/`phases.json`. Neither npm's error code nor its private cache/log survived in retained artifacts.

npm 11.19.1 uses a numeric errno as its exit status. Linux ECONNRESET's -104 truncates to 152, but **152 alone proves no errno, network failure, package, URL or lifecycle failure**. No application regression or network root cause is established.

This non-UI failure remains a release blocker under the no-flakiness rule. New diagnostics, generic stabilization or passing qualification do not explain it. No historical-attribution exception has been granted; no historical cause or fix is claimed.

## Decision (2026-10-22; local, undeployed)

Retain bounded, allowlisted npm diagnostics in the existing phases upload; never upload raw logs, URLs, credentials, commands or payloads. Separate npm JSON stdout from stderr. Parse the entire stdout document, bounded to 64 KiB per stream; missing, malformed, noisy, unreadable or oversized diagnostics fail closed. Export only finite classification/code/errno, clipping, safe signal, attempt, elapsed time, backoff and decision.

Permit at most three installation attempts under one shared **300s** install budget, including interruptible **1s/2s** backoffs. Each subprocess receives only the remaining budget; owned-process cleanup still runs after timeout (up to 6s, plus I/O), so this is not a 300s hard wall. Disable npm fetch retries to avoid multiplying retries. Tests are never retried.

Replay requires a numeric nonzero, unsignaled exit, npm's final structured network code, a matching stderr code and identical npm-prefixed stderr fetch summary, with the known top-level `request to … failed, reason: …` fetch summary (including npm's `FetchError: ` prefix). Lifecycle/command markers and recognized terminal auth, certificate, integrity and lock errors veto replay; unknown codes/shapes, interruption, subprocess timeout, spawn, I/O and cleanup failures remain terminal. Exit 152 without those diagnostics is terminal.

**Why not npm fetch settings alone?** npm already retries fetches, and its installed adapter's catch path is broader than this terminal-error policy. Explicit classification avoids blanket retries. Whole-install replay can repeat lifecycle scripts: the exact pinned root has no install lifecycle scripts, its lock resolves only registry tarballs plus bundled entries, and Arborist unpacks before its build phase. This is a pinned fixture policy, not a general npm retry facility. A changed source pin requires renewed review; lifecycle failures never qualify.

## Local validation

`npm ci` completed before checks. Tests first failed on absent exports (`red.log`); additional REDs exposed terminal-marker admission, deadline overrun, missing clock/cleanup ports, absent backoff, malformed-summary coercion signal loss and missing stderr fetch-summary agreement (`red-adapter.log`, `red-backoff.log`, `red-review.log`, `red-fetch-agreement.log`). Running the actual wrapper regressions against an untouched baseline module also fails on absent retry/decision metadata (`red-baseline-adapter-refined.log`).

The focused suite passes **56 tests**. It includes real stub git/npm preparation through persisted manifest/phases (network exhaustion, spoofed lifecycle output, unknown exit 152 and clipping), real self-SIGTERM after transient diagnostics, finite-field sanitation and deterministic budget/backoff/cancellation/cleanup checks. These controlled regressions validate the new boundary, not the original cause. Full infrastructure checks pass (122 Node, 220 Python and 33 guest tests after the final summary-agreement change); scoped Biome, Node syntax and diff whitespace checks pass. Final receipts: `green-fetch-agreement.log`, `infra-final.log`, `lint-final.log`. A controlled local socket-reset probe against npm 11.19.1 confirms the real `npm error network request to …` shape and string errno (`real-npm-reset-probe.json`); it does not reproduce the historical failure. No hosted qualification or deployment.
