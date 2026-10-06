# Mutable-source qualification (2026-10-04)

## Evidence

A full Claude POC E2E run started while implementation/formatting continued. Formatting `packages/protocol/src/index.ts` at 09:10:10 PDT changed the module watched by the frontend fixture. At 09:10:11–12, Vite invalidated importing components and reloaded `App.tsx` during the mobile reader-position scenario.

That run cannot qualify the product. It was cancelled rather than reused as acceptance evidence. Its log remains at `/tmp/claude-poc-full-e2e.log`; targeted browser checks completed separately. The concurrent full unit run is separate evidence, not an E2E substitute.

## Rule

Freeze all imported implementation files and dependency manifests before browser qualification. Build first, run checks without edits or concurrent dependency installation, and verify source hashes afterward. Do not treat a passing rerun as clearing an unexplained failure; here the filesystem modification time and Vite reload establish the uncontrolled schedule.

## Outcome

After fixing explicit creation/tab-order test assumptions and restoring selected-harness-before-GitHub authorization, sequential frozen-tree validation passed 2,650 unit/DST tests, 113 infrastructure tests and all 303 Docker/PostgreSQL/browser E2Es. The PGlite FIFO assertions executed under exclusive ownership; the fixture timeout was not a store defect. Before/after source hashes matched. Failed and final logs remain under `.context/claude-poc/`.

No production deployment or credentials were involved.
