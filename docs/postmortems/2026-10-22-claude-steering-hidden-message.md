# Consumed Claude image input hidden in the browser

2026-10-22, America/Los_Angeles (PDT). Orb `41e93372-1f55-41e1-88f4-66cfc520739e`. Read-only API and transcript observations confirmed durable delivery, not a failed image submission.

## Evidence

- Inbox `9110435f-2798-478a-b085-3bad1f1241cb`: created **17:37:20.544 PDT**, updated **17:37:22.869 PDT**, `status:delivered`, `delivery:steer`, operation `7f39009b-f346-4fac-a13e-c53ebb9c6229`.
- Content: one `image/png`, 276,704 base64 characters, and “Actually I also want Compare! The agent often does sometjhing like this, which compare would be better for. so add that to the prototype page and let me play around with it!”
- Canonical `claude.input_receipt` `b27ba84c-1192-432e-8670-8707f08f7e0f`, **17:37:22.273 PDT**, names that inbox ID but has no content. Its proof identifies attachment `13a78846-399e-42f0-8a54-81aa9ad579b0`, attachment line 940, consumption line 941, `inputKind:human`, session `8982654c-24e4-45db-a511-c1e9d2528cb0`.
- Only three user-role records were present; none contained a user image. A separate screenshot in tool output was initially mistaken for user-image evidence and excluded after inspection.

Times above correspond to `2026-10-23T00:37:20.544Z`, `00:37:22.869Z`, and `00:37:22.273Z`. Observations were filtered in tool output; no raw image-bearing response was saved. This report preserves the observed identifiers and metadata, not a claimed raw snapshot. No target mutation, replay, restart, or deployment occurred.

## Cause

Claude busy input can persist as `attachment/queued_command` rather than a native user row. The runtime's guarded consumption proof produces a contentless `claude.input_receipt` with the original inbox IDs (`docs/claude-agent-sdk.md`). The browser treated every such ID as a complete presentation handoff, removed the inbox body, and did not render the hidden receipt. Delivery succeeded while image and text vanished from the transcript.

The image was below the input size limit. Missing user-role records alone did not establish lost delivery; joining the exact inbox and consumption receipt did.

## Correction

**Decision — 2026-10-22; implemented locally, undeployed:** retain the existing inbox body for contentless Claude receipts and render it at the receipt's canonical record position. Preserve receipt ID order for batches, deduplicate repeated receipts, and let a content-bearing canonical record anywhere in history take precedence. Retain human/system/peer styling and the delivered status. Receipt-bound rows are not tail-pending rows, so subsequent live output can join the final assistant turn.

Consumption and presentation are separate: the hidden receipt satisfies history-repair checks even though its inbox body remains needed. Initial inbox polling restores that body after reload; subsequent polls refresh metadata without fetching its image again. Native history, receipt proof, persistence, runtime routes, image routes, and lifecycle admission are unchanged. Receipt position follows canonical record order, not an invented timestamp ordering.

Keeping delivered rows permanently at the transcript tail was rejected: it misorders history and permanently separates live output. Adding content to persisted receipts was not selected; the durable inbox already owns it. Existing queryable receipt/inbox IDs diagnose the handoff; restored content and delivered status expose its outcome to the user without new telemetry or payload logging.

## Validation

`npm ci` preceded tests. New queue/renderer tests first failed because the receipt retired the body; a batch/dedup test also failed before the fix. Preserved local evidence: `.context/claude-busy-inbox-visibility/red.log` and `red-batches.log`.

All 873 web unit tests, web and E2E typechecks pass. Chromium and WebKit regressions verify decoded image/text once at the receipt, canonical ordering, reload, and unchanged history-read counts across subsequent metadata polls. Two existing Chromium long-history polling/typing regressions also pass.

First browser failures remain in `browser-first.log` (stale test-only Vite render-counter anchor) and `browser-anchor-fixed.log` (incorrect assumption of one cold history request). The anchor now uses an existing render-local declaration. React StrictMode starts/cancels an initial load; repair assertions compare post-render request counts across explicit poll boundaries rather than assuming a boot count. Corrected runs: `browser-green.log` and `browser-long-history.log`, in the same local evidence directory. This is scoped frontend qualification, not full release qualification.
