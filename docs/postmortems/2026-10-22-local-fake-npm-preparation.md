# Local fake-provider npm preparation failure (2026-10-22)

## Evidence

[Durable 39844782648, process 1/4](https://github.com/schani/pi-orb/actions/runs/39844782648/job/120055086578) tested `9691ef3ce7ec157bfc9408a1bb59b4ee2b4a378d`, blocking [Deploy 39845276226](https://github.com/schani/pi-orb/actions/runs/39845276226). Git and lock-pin checks passed; `npm ci --no-audit --no-fund` exited **152** after **12.094s** (1:00:43.587–1:00:55.681 PM America/Los_Angeles). Tests never launched. Manifest: `code: 1`, `error: tool_failed`, `cleanupError: null`.

Artifacts `local-fake-process-1-39844782648-1` (ID `12454592660`) and `central-process-1-39844782648-1` (ID `12453774050`), original logs, hashes and diagnosis remain in `/tmp/qualification-39844782648/` and `.context/local-fake-install/`. All 19 central-process JSON files match tracked historical fixtures; none is a new failure trace.

**Cause unknown:** private npm logs were not uploaded. npm can truncate errno -104 to exit 152, but that status alone establishes neither ECONNRESET nor any network or lifecycle cause. No historical fix is claimed.

## Decision (2026-10-22)

The user waived attribution of this original npm failure only. New failures, exact-head CI qualification, assertions and DST replay requirements remain unchanged.

Retain bounded, finite allowlisted npm code/errno diagnostics in the existing finished-install phase, never raw logs, URLs, commands or credentials. These fields are observations, not root-cause classification. Keep npm's defaults, one installation invocation and the existing 300s tool timeout; no custom replay policy.

Focused tests cover sanitation, missing/conflicting/oversized diagnostics and actual failed preparation through persisted artifacts, including one unchanged npm invocation. RED/GREEN and infrastructure receipts remain in `.context/local-fake-install/`.
