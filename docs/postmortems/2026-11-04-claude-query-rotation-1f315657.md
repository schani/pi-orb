# Claude shutdown race: 1f315657

2026-11-04, America/Los_Angeles. Orb `1f315657` retained late root requesting and matched task-terminal edges during closing, then failed `claude_rotation_uncertain`. The retained zero-turn `priorResult` was mutable: it does not establish the initial close trigger. Task type/tool association and initiating cause remain unproven. Neither zero-turn filtering nor Monitor deduplication follows from this evidence.

Decision (2026-11-05): capture immutable first-close state and bounded close-time SDK identities/order, without changing quiescence or recovery. Contract: `docs/claude-agent-sdk.md`. Attribution follow-up: `TODO.md`.

Full investigation and original diff: ignored `.context/shutdown-diagnostics/superseded/`; source evidence and hashes: `.context/claude-rotation-1f315657/`. No repair or causal fix is claimed here.
