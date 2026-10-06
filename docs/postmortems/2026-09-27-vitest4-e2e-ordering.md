# Vitest 4 E2E ordering inversion

During the security upgrade from Vitest 3.2.7 to 4.1.11, the actual-config ownership probe failed: lifecycle files started before frontend files. Its barrier timed out; increasing that deadline would not correct ownership.

Vitest 4 ignores `poolOptions`. After moving worker caps to project `maxWorkers: 1`, its scheduler deferred isolated `groupOrder: 0` files until after other groups. The old frontend/lifecycle orders 0/1 therefore inverted execution. Inspection of the installed scheduler and recorded start events established the cause.

Orders 1/2 preserve frontend-before-lifecycle, one thread/fork respectively, isolation and unchanged timeouts. The probe checks actual pools, non-overlapping setup/frontend ownership, lifecycle peak concurrency one and child environment inheritance. It passed after the causal configuration fix. This is not full E2E qualification.

The upgrade also removed incidental ambient Node types. Typecheck failed before the root explicitly declared the existing `@types/node` version and included `node` in compiler types; strictness and browser DOM libraries were unchanged. Typecheck then passed.

Private evidence: `.context/consolidation/preparation-20260927/dependencies/vitest4-status.md`, `vitest4-config-after.log`, `vitest4-config-diagnostic.log` and the retained typecheck failure. No deployment occurred during this repair.
