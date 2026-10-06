# Claude subscription completion never reached submission

## Incident

The owner entered the browser completion code and clicked **Complete connection**. The form cleared without progress feedback; the native helper eventually timed out after ten minutes. The real code/token was not inspected or replayed.

## Cause

The PTY adapter wrote `${code}\r` in one chunk. Claude Code 2.1.289's Ink input treated that as pasted line-edit text, not an Enter event. Native challenge-only qualification had never exercised completion input. The adapter also suppressed every post-submission redraw/error until native exit or timeout, obscuring the distinction between accepted HTTP input and a started exchange.

## Evidence

A genuine pinned `claude setup-token` subprocess ran with a scratch home/config and kernel denial of all internet destinations. A synthetic code used only that test ceremony's state. No owner consent, real credential, upstream request or inference occurred; no raw PTY output, code or private authorization URL was retained.

The original single-chunk write produced a masked redraw and stalled. A separate Enter after that redraw immediately produced native `EAI_AGAIN`. Native diff rendering can omit unchanged masking characters, so mask counts do not equal input length; the cursor-positioned masked redraw is the acknowledgment. Regression tests reproduce the original production-helper stall and qualify short/long bracketed-paste completion through the production transport under the same kernel guard. Native errors are classified, never forwarded verbatim.

## Local qualification

The combined notice/auth changes passed 2,705 unit/DST tests (eight conditional skips), 113 infrastructure tests, workspace/E2E typecheck and the separate genuine native input contracts. Chromium/WebKit notice regressions passed. The local process backend was restarted with retained database/auth storage and the rebuilt frontend; no active login or running runtime was interrupted. Cloud deployment and successful subscription token issuance remain unqualified. Sanitized evidence: `.context/claude-auth-input/`.

## Resulting rules

- Send bracketed paste, await its native masked redraw, then send Enter separately. No sleep-based key timing.
- Clear the published challenge on code acceptance and reject duplicate submissions.
- Distinguish accepted code, completed native input and native exchange/validation failure in sanitized `lifecycle:` edges. A timeout records both admission/completion facts.
- Recognized native failure is immediately visible and ends the helper; it does not wait for the ten-minute deadline.
- Native input qualification does not prove successful token issuance or subscription billing. Those still require owner-authorized live qualification.
