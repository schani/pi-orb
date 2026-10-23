# Consumed Claude image input hidden in the browser

2026-10-22 (PDT), orb `41e93372-1f55-41e1-88f4-66cfc520739e`. Read-only observations; no target mutation or deployment.

- Inbox `9110435f-2798-478a-b085-3bad1f1241cb`: created 17:37:20.544, delivered/steer at 17:37:22.869; operation `7f39009b-f346-4fac-a13e-c53ebb9c6229`. Content: PNG (276,704 base64 characters) and a request to add Compare to the prototype.
- Contentless `claude.input_receipt` `b27ba84c-1192-432e-8670-8707f08f7e0f`, 17:37:22.273, names that inbox ID. Human consumption proof: attachment `13a78846-399e-42f0-8a54-81aa9ad579b0`, lines 940/941, session `8982654c-24e4-45db-a511-c1e9d2528cb0`.
- No user image appeared in the three user records. A tool-output screenshot was excluded as unrelated. Raw image-bearing responses were not saved; these are observed identifiers, not a raw snapshot.

Claude busy input persisted as `attachment/queued_command`, not a user row. The browser retired its inbox body on the hidden receipt, so successful delivery erased both image and text. Correction: `docs/web-ui.md`. Permanent tail placement was rejected because it misorders history and splits live output; persisted receipt content was unnecessary because the inbox already owns it. Existing queryable inbox/receipt identities diagnose the handoff; visible content/status exposes the outcome without payload logging.

Validation evidence remains in `.context/claude-busy-inbox-visibility/`: `red.log` and `red-batches.log` establish pre-fix failures. `browser-first.log` caught a stale Vite instrumentation anchor; `browser-anchor-fixed.log` caught an invalid single-cold-request assumption under StrictMode. Both were corrected, not timeout-suppressed. The consolidated browser test's first Chromium launch lacked its Playwright executable (`simplified-browser-first.log`); installing the required headless shell corrected that environment failure. Scoped unit/browser/typecheck/lint qualification is recorded in `simplified-*.log`; no release qualification is claimed.
