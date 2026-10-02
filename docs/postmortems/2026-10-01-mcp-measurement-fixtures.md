# MCP measurement fixture failures — 2026-10-01

These failures concern qualification fixtures, not provider authorization or a deployed SDK change. Executed archives remain immutable under `.context/finish-20261001/context/`; scope records are under `.context/finish-20261001/scopes/`.

## Scope capture

Both owned grants refreshed normally through the broker's lease/CAS path. Generations 6→7 exceeded the observer's original 4 KiB response budget. Later captures encountered its separate 2,048-character scope limit; generation 8→9 diagnostics identified `too_long`. Publication succeeded independently of observation.

Tests preceded replacing those overlapping limits with one 64 KiB response bound and a two-second deadline. Scope-token validation follows RFC 6749. Only public `mcp_all` membership and distinct unknown-name counts leave memory; response bodies and unknown names do not.

One naturally expired refresh per binding at 22:33 UTC published generation 9→10. Cloudflare returned 384 distinct unknown scopes; Datadog returned 164. Neither included `mcp_all`. This is actual token-response evidence, not requested/discovered scopes or a complete scope inventory. The first Cloudflare read-only preflight's secret-read failure remains recorded; no refresh was attempted by that failed preflight.

## Context capture

- Archive `02960069e67bb4440c2f86910380af5efdf4db838930cc49d07a868a16e296a2` failed its guest offline check. The wrapper discarded the failing output, so that first failure's precise cause is unavailable. A same-artifact offline reproduction captured `ENOTEMPTY`: asynchronous SDK credential writes recreated a file during temporary-directory cleanup. Fake fixtures now use an in-memory credential store and no models file. A passing isolated rerun did not clear the original failure.
- Archive `31a2e0186bf99cc7e52e5bde21a09dfa52ab22c3fd0a43b0cfbc48b30d81f5fb` passed preflight but returned `search_unavailable`; its diagnostics did not isolate the failing stage. Offline characterization subsequently proved that loader reload discarded transient default-tool overrides. The fixture now persists settings and explicitly applies production codemode activation. Root searches use the public native SDK outside inference; no model-adherence or synthetic-hook claim is made.
- Archive `fa4b516bc592aa0c6d3e967d35577a2d4d3e0f83c88aef6e36f34730746a5c97` passed preflight but the wrapper rejected its output. A contract test found that the wrapper accepted `child_unavailable` without diagnostics but rejected the producer's diagnostic-bearing variant. Fixed validation metadata preserves a known status and failure stage without exposing rejected payloads. The discarded original output cannot establish its precise cause.
- Wrapper-only archive `654f325e477598d420f358fffb60a5b1169f8a063d94ece832d3eb28aae7ca32` reported `child_unavailable` at `root_child`. Both model turns completed; root exposed 3 Cloudflare/33 Datadog tools, child zero. Real vendor `service.spawn` tests reproduced zero exposed tools with both fresh and sequential roots despite successful independent fake-server discovery. The static general-purpose allowlist filters native definitions from the public SDK registry. Discovery and exposure are different observations.

The corrected fixture uses an explicit private worker profile with the 36 approved native names plus codemode; the independent empty baseline permits codemode only. A bounded SDK preview builds the profile before measurement. This does not widen general-purpose or production permissions. Actual vendor-child tests require independent fake discovery, 36 exposed tools in the provider declaration, and zero business calls. Live acceptance requires real Sol completion and actual provider hooks; child searches remain zero. JSON bytes/codepoints are not model tokens.

Archive `963c841a7ef29c95a258ef2bddbdd02fd3830d16bdd1f4c6169d8c3ee2f3b96f` passed the corrected live gate at 22:39–22:40 UTC: real Sol, 36 exposed tools in root and explicit child, two harness searches in root, none in child, and no model tool calls. Its independent baseline and payload sizes are in `docs/mcp.md`; local proof is `.context/finish-20261001/context/qualification963c/evidence.json`. This is a different, explicitly permitted child profile, not a reinterpretation of the general-purpose run.

## Subsequent default-policy change (2026-10-02)

The user requested MCP access for built-in general-purpose children. The registry had converted an omitted tool list into finite built-ins; the assembler and codemode wrapper also narrowed the SDK policy. The patch now preserves omission as unrestricted approved-resource access while retaining explicit restrictions. Actual vendor and browser regressions cover the default path; the earlier custom-worker archive is unchanged.

Validation exposed three fixture defects: mixed root/child payload selection, an assertion demanding private child tool output in root history, and an in-flight Playwright route surviving page teardown. Fixes identify requests by SDK session ID, assert history privacy alongside authenticated upstream execution, and await route handlers before page closure. Failures and the subsequent 248-case acceptance remain in `.context/general-purpose-mcp/validation/`; counts and scope are in `docs/testing.md`.

## Resulting rules

Keep publication separate from observation, exposed tools separate from discovery, and independent baselines separate from same-session transitions. Test the actual vendor child path rather than substituting another root session. Validate every producer failure variant and preserve bounded diagnostic metadata when rejecting a payload. Do not change historical artifacts or reinterpret failures after a later success.

Current qualification and remaining acceptance are recorded in `docs/mcp.md`, `docs/testing.md` and `TODO.md`.
