# Nested MCP calls appeared as empty rows (2026-10-02)

The SDK emits `tool_execution_start/end` for codemode's child calls with `parentToolCallId`. The runtime published each as a standalone live `tool_state`, but Pi persists only the parent assistant call and result. These phantom rows had null arguments and no result, persisted across subsequent thinking, and displayed `(no details)`. The parent result already held codemode output and bounded native nested-call arguments/status.

The runtime now excludes nested SDK events from standalone live states, retaining model-issued direct MCP calls. Browser regression holds the next model turn after the parent commit to verify the parent disclosure and absence of phantom rows during live activity and after completion. Child-subagent results remain private to their own history.

Provider audit scope: 16 nested SDK calls reported `ok` and MCP text was nonempty. Six `Promise.allSettled` `fulfilled` wrappers do not establish business-level success; that remains unproved. Existing running guests require restart to load the runtime fix; no compatibility path is needed.
