# Codemode loadout failure (2026-10-03)

## Observation and evidence

The main session's `pi-orb:extension-error` record (line 201) at **2026-10-03 07:20:08 America/Los_Angeles** contains:

```text
Pi extension failed: <inline:pi-orb:codemode> (prepare_loadout)
```

The inspected installed SDK's `core/agent-session.js` catches exceptions from `definition.prepareLoadout` and emits `prepare_loadout` with the exception message and stack. This identifies a hook failure, not an import failure. Runtime `apps/orb-runtime/src/pi/agent.ts` persists only the extension path and event, discarding the original exception message and stack. The session record, inspected boot-hook logs and searched local journal window provide no underlying cause.

## Limits and finding

Root cause and any causal relationship to the reported involuntary restart remain unproved. Installed coding-agent and codemode packages both report `1.0.0`, and the inspected loadout API matches the hook's calls; neither establishes the failed process's artifact or excludes a mismatch there.

Extension path/event alone cannot diagnose a loadout exception. Durable user-visible diagnostics need a sanitized, bounded cause/stack. Follow-up lives in `TODO.md`; no fix was implemented. Pi Durable research remains preserved and unapproved.
