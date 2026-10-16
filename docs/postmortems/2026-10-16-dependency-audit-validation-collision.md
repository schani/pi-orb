# Dependency-audit validation install collision

**2026-10-16, America/Los_Angeles.** Local validation harness failure, not a demonstrated product defect.

## First failure

`node --test scripts/apply-dependency-patches.test.mjs` reported **18 tests: 6 passed, 12 failed** during dependency cleanup validation. Retained first-failure excerpts:

```text
Pi-only installs core, AI, coding-agent and codemode and exposes selective cancellation
Error: Cannot find package '/tmp/pi-orb-dependency-patches-8h4lo2/node_modules/partial-json/index.js'
imported from .../node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js
code: 'ERR_MODULE_NOT_FOUND'

Pi-only refuses missing pi-agent-core before modifying another package
Error: ENOENT: no such file or directory, lstat
'/workspace/repo/node_modules/@earendil-works/pi-agent-core/package.json'
```

## Cause and correction

The tests copy installed dependencies into owned fixtures. Another worker concurrently ran root `npm ci` (**PID4969**, started **10:16:58 PDT**), deleting/repopulating their shared source `node_modules`. Process evidence captured at **10:17:16 PDT** showed that install still running; `pi-agent-core/package.json` was recreated at **10:17:12.117785790 PDT**, while `partial-json/index.js` remained absent. Missing fixture and root files are consistent with copying the partially replaced install, not a patch assertion defect.

Correction: one validator exclusively owns root installation and all checks; other workers do not install or test against that tree concurrently. No product code, test assertions or timeouts changed to clear this failure. Passing reruns alone would not establish the cause; the concurrent process and file timestamps do. Subsequent qualification is recorded separately in `docs/testing.md`.

Raw first-failure sources: `/tmp/dependency-removal-validation.log` and `/tmp/dependency-removal-concurrent-install-evidence.log`; the excerpts and ownership evidence above are retained here without depending on those temporary files.
