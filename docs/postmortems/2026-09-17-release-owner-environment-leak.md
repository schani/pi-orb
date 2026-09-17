# Release checks inherited the production migration owner

## Evidence (2026-09-17)

Deploy run [35284149086](https://github.com/schani/pi-orb/actions/runs/35284149086) stopped in `checks` before build, migration, or apply. Its durable record is `failed-before-apply`, with `applyAttempted: false` and no migration job. The preserved log under `.context/deploy-35284149086/` shows 279 unit-test files passed. E2E then reported 16 passing and seven failing files; 163 of 173 tests passed, six were skipped, and four failed after control-plane children exited during migration.

The workflow correctly supplied the independently verified production `PI_ORB_USER_ID` to `infra/release.sh`. The release exported that deployment-only input to every check child. Fresh E2E databases therefore selected the production UUID for migration 024, but had no matching user. Startup failed closed with the migration invariant. The isolated E2E workflow had already passed the same 173 tests because it did not carry deployment ownership input.

This was deterministic environment coupling, not an E2E or migration-validation defect. The migration correctly rejected an unknown selected owner. No timeout, assertion, fallback, or owner validation was weakened. The first failure evidence remains preserved; a passing isolated workflow does not clear it.

## Correction and rule

The release check boundary now removes `PI_ORB_USER_ID`, the complete `PI_ORB_ORIGINAL_*` bootstrap tuple, and release-recorder variables from dependency installation, browser installation, typecheck, lint, unit tests, the local runtime-image build, and E2E. These commands must construct test ownership from their own fixtures.

The release validates owner input before external work and retains it in the parent. Only the migration job receives the selected owner and optional all-or-none bootstrap tuple through its explicit `--set-env-vars` argument. Smoke retains the selected user through the release parent. A shell-contract regression runs the complete mocked release with both owner forms, requires every check command to see none of them, and requires the migration job to receive the exact validated tuple.

Deployment-only configuration must cross only the adapter boundary that consumes it. A child inheriting the release environment is not an explicit contract, even when the value is non-secret.
