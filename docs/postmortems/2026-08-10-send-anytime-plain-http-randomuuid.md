# Send-anytime submission failed on the plain-HTTP tailnet UI

**Date:** 2026-08-10

**Impact:** Clicking send or pressing Cmd/Ctrl+Enter while an orb was waiting for device login did nothing. No inbox row or HTTP request was produced.

## What happened

The new message path generated its idempotency key with a direct `crypto.randomUUID()` call in `OrbPage`. Localhost testing passed because browsers treat localhost as a trustworthy context. The product URL is plain HTTP on a tailnet hostname, where `randomUUID` may be unavailable. The click handler threw before calling the control-plane API, and the UI surfaced no error.

The repository already had `apps/web/src/lib/uuid.ts` for exactly this constraint, and project/orb creation used it. The new message path bypassed it. Pasted-image IDs had the same latent defect.

## Fix and invariant

Both message and image IDs now use `generateUuid()`, whose `getRandomValues()` fallback works on the supported plain-HTTP origin. A focused test removes `randomUUID` and exercises the fallback. Browser code must never call `crypto.randomUUID()` directly; `docs/control-plane-api.md` records the rule.
