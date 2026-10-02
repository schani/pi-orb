# Native MCP validation install race (2026-09-29)

## Failure and scope

During local Pi 0.99.1 integration, a root `npm ci` ran concurrently with agents invoking `npx vitest`. The repository's pinned Vitest is 3.2.7; while installation changed `node_modules`, `npx` fetched transient Vitest 5. The overlapping checks reported missing/undefined SDK exports. These runs did **not** validate the pinned dependency graph or establish an application defect. Local failure evidence is retained under `.context/native-mcp-e2e/`, including focused MCP/OAuth/child/browser logs; no full-gate verdict follows from their partial green results. Production was not changed.

## Cause and correction

The installer and validators shared one mutable dependency tree without an ownership barrier. With the local binary temporarily absent, unguarded `npx` installed a different runner; module resolution during install could also see incomplete SDK exports. A test rerun alone cannot clear the failed gate. Give one parent sole install/test ownership: finish a clean `npm ci` before allowing any agent to validate against that checkout, and prohibit installs while validation runs. Invoke repo-local binaries or npm scripts after install; if a local tool is missing, fail rather than allowing `npx` to fetch it. Then run full gates against one stable source/dependency tree, preserving first failures and investigating any new failure on its own merits. No mutex framework or timeout adjustment is needed.

This is a tooling/resource collision, not evidence of flaky product behavior. After exclusive clean installation, the full repository and Docker/PostgreSQL/browser gates passed on 2026-09-30; subsequent deterministic fixture failures were diagnosed separately. Results and preserved evidence: `docs/testing.md`. No deployment.
