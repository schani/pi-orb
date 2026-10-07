# Stopped nested Claude owner never resumed

Date: 2026-10-06 (America/Cancun). Local policy implementation; undeployed.

## Incident

In the reported `fd7129` parallel review, the ninth reviewer spawned three nested workers and returned a waiting reply. That reviewer never resumed. Root waited, then completed without a combined list. Root completion does not prove each reviewer's synthesis was consumed.

## Established mechanism

Owned loopback-provider probes use real SDK 0.3.289 and native CLI 2.1.289 with isolated configuration and dummy credentials. They reproduce three descendant completions reaching root while the stopped reviewer receives no continuation. Native parked-owner eligibility requires interactive mode; SDK piped stdout is noninteractive. Holding stdin open is not a repair.

Public `PreToolUse` input rewriting works for ordinary foreground definitions, but cannot enforce that mode for arbitrary agents. Production settings load user/project/local definitions without an SDK agents dictionary. A project definition with `background: true` forces asynchronous execution despite rewritten `run_in_background: false`; even `general-purpose` can be overridden. Public `AgentInfo` supplies no effective background or source identity. Name allowlists cannot establish safety.

Evidence: `.context/claude-nested-continuation/{adapter-findings,native-hook-findings,project-findings}.md`, their content-free traces and pinned source hashes. These controlled probes establish the unsupported native mode, not every detail of the field incident or live-provider answer quality.

## Decision

**User-approved 2026-10-07:** root owns all native delegation. Deny any worker `Agent` call, identified solely by nonempty public `BaseHookInput.agent_id`, before execution. Native reason: `Delegate from the root; complete this assignment directly.` Preserve root parallel/background/custom delegation, project configuration and ordinary worker tools.

Commit hidden `claude.nested_delegation_denied` before denial, with session/query/operation/agent/tool-use IDs only. Publication failure fails health and still denies without throwing. Missing operation or stale query denies without attribution to another operation. Native tool results expose the denial; internal diagnostic records stay hidden. Affected-query diagnostics remain bounded and sanitized. Existing ownership, stale-handoff and crash-cut guards remain independent.

Rejected: input-only foregrounding, trusted builtin names, custom-definition substitution, holding input open, prompt-only continuation, automatic retries, replay and synthetic `SendMessage` orchestration. No new task manager is required.

This policy removes unsupported nested continuation. It cannot guarantee semantically complete LLM answers or retroactively resume existing tasks. Adapter regression evidence is retained in `.context/claude-nested-continuation/rootpolicy-*`; separate real-native qualification and final repository E2E are required before deployment.
