# npm 12 blocks bundled SQLite installation

## Evidence (2026-11-04, PST)

PR 252's old-head `fa95558b` hosted E2E shards fail before tests with
`service_failed` after successful npm installation. Exact-base `7c25f138` passes
all four E2E shards on npm 11.20.0 with the same fixture pin/lock/generated hash.
Hosted receipts: `/workspace/toolchain-ci-evidence/`.

The first local stacked-candidate wrapper attempt exits 1 with `proc_read`.
Its retained private provider log shows the backend exiting because no
`better_sqlite3.node` exists. It had already installed the locked tree successfully.
First evidence: `/workspace/npm-upgrade-evidence/stack243-wrapper-first{.log,.exit,-private/}`.

## Cause and decision

Fling 0.0.71 bundles SQLite 12.11.1 (`inBundle: true`). npm 12's
[identity matcher](https://github.com/npm/cli/blob/v12.2.1/workspaces/arborist/lib/script-allowed.js)
returns no approval for every bundled dependency, regardless of `allowScripts`:
the bundle's self-reported name/version cannot establish registry identity.
An exact SQLite approval therefore cannot execute its native installation.
Broad script-policy bypasses are unnecessary and rejected.

After verifying the pinned Fling artifact/installed version, locked SQLite bundle
version, installed version at the fixed bundle path, explicitly run only its `install`
script. Keep cloudflared denied and esbuild exactly approved. Existing phase
artifacts record `sqlite_install` before launch, including bounded failure codes.
No package graph, lockfile or fixture pin changes.

## Qualification and limits

Tests reject SQLite version/bundle drift, observe policy before `npm ci`, assert
one ordered native hook, propagate hook failure and forbid service/test launch.
The corrected actual wrapper installs, reaches owned worker/Vite readiness,
migrations and health, executes a successful child and cleans both groups without
escalation. Receipts: `/workspace/npm-upgrade-evidence/stack243-wrapper-fixed/`.
A direct explicit install also produces a working SQLite database on ABI 147.

The original local `proc_read` lacks syscall/errno evidence; its exact adapter
cause is unproven and no proc-handling fix is claimed. Strict proc-error handling
is unchanged. The missing native binding is directly evidenced and corrected;
the successful startup follows that causal change, not an unchanged retry.
Full stacked E2E and hosted exact-head qualification remain pending.
