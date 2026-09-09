# Upload E2E advanced the ordered inference script past archival

**Date:** 2026-09-09. **Scope:** test-harness defect; no production incident or deployment.

The first process-provider full-suite run successfully transferred a 4 MiB + 13 byte binary file from Chromium through the control plane into the runtime. The resulting inbox message made Pi invoke `sha256sum`, and its scripted final response was `UPLOAD_VERIFIED`. A later self-archive step timed out.

Preserved local evidence is `.context/upload-e2e-first-failure/` (run log, relevant replicated histories, orb/message snapshots, and runtime logs). The original complete runner log is `/tmp/upload-full-e2e.log`. The archive orb's history contained its user message followed by an assistant error with `no_matching_rule`, not an upload/lifecycle failure. The upload orb's history contained the expected file path, tool result digest `eaaf4e61f19fb2d731723320428932568089be2d1057569f136163d42245070d`, and final response.

## Cause

The remote fake OpenAI script consumes rules in order. The test inserted upload rules *after* the archive rules but performed upload *before* archival. Selecting upload rules 9 and 10 advanced the shared script beyond archive rules 7 and 8. The upload turn also spawned an asynchronous Luna notification inference; with no corresponding rule, it consumed fallback rule 11. The subsequent archive prompt had no remaining match. This failure follows from the script order; increasing the archive timeout or rerunning unchanged cannot repair it.

## Fix and invariant

Order the script like the scenario: spawn and its notification, upload/tool result and its notification, then archive/tool result. Add a dedicated upload-summary rule and explicitly await its recorded acceptance before admitting the archive prompt. A turn's visible final response is not a barrier for asynchronous notification inference.

Full-slice scenarios that share an ordered fake-model session must account for **every** inference consumer and synchronize on the recorded rule-acceptance boundary before progressing past it. The existing spawn-summary barrier established this rule already; the upload addition must preserve it. No product assertion or timeout was relaxed.
