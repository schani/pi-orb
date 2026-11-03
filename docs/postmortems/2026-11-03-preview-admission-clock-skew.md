# Preview admission rejected under clock skew (2026-11-03)

## Symptom

During live acceptance of HTTP previews on `piorb.live` (orb `bc64a339`), some preview
requests failed with JSON 401. Firefox reported `NS_ERROR_CORRUPTED_CONTENT` for
`/@vite/client`, and the page once showed "Preview runtime forwarding failed". Cloud Logging
recorded `preview-transport-failed phase=connect reason=unauthenticated` at 15:23:52,
15:41:06 and 15:41:07 UTC, each followed by `preview-transport-recovered`.

## Cause

The control plane signed each runtime admission with `expiresAt = now + 10_000`. The runtime
rejects `expiresAt > now + 10_000`. The bounds were equal with no margin, so a Cloud Run clock
ahead of the orb VM's by more than the request's transit time made the runtime reject a valid
admission as unauthenticated. The orb measured its VM NTP offset at +4.2 ms; the Cloud Run
side's offset was not measured, so the exact skew is inferred.

## Fix

The control plane now signs for 5 seconds; the runtime keeps its 10-second cap. Admissions
therefore survive up to 5 seconds of skew either way. A contract test verifies a real
control-plane envelope with the runtime's verifier at clocks 4.9 seconds behind, equal and
4.9 seconds ahead; it failed against the old signing.

## Rule

When two independently synchronized clocks validate a bound, the issuer must leave explicit
skew margin inside the verifier's window. Never sign at the verifier's limit.
