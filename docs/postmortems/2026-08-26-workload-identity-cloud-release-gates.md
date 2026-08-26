# 2026-08-26 workload-identity cloud release gates

## Summary

The first production deployment of the cloud workload-identity tier moved commit
`c0008ae28eb149c302e2bd4483122592718c642f` onto all four Cloud Run services, but the supported
release transaction did not complete. Three independently useful gates exposed three cloud
composition defects:

1. OpenTofu compared the issuer service's canonical `uri` with the deterministic issuer URL and
   failed its postcondition. Cloud Run returned the hashed canonical URI in `self.uri`, while both
   the hashed URI and the deterministic project-number URI were present in `self.urls` and answered
   successfully. The deterministic URL and advertised issuer were correct; the equality assertion
   was not.
2. The runtime revision became ready before the browser revision had applied migration 011. Its
   bounded boot hook durably logged `issuer-key-unavailable` with
   `relation "oidc_signing_keys" does not exist`, exhausted its retries, and left JWKS at the
   designed uncached `503 no signing keys published yet`. A same-image runtime restart after the
   migration activated the first key and restored JWKS to `200`.
3. The workload-identity smoke booted both real GCE orbs but failed its first in-orb mint because
   `gcloud compute ssh` exited 255. The `pi-orb` VPC had only the control-plane-to-runtime
   `tcp:8080` ingress rule; implied deny blocked port 22, including the documented IAP tunnel path.

The ordinary lifecycle smoke passed create, first boot, stop, restart, and final stop in 319
seconds. The workload-identity smoke was not rerun: the SSH failure was deterministic and remains a
release blocker. The separately bootstrapped GCP WIF tier was not configured, so its STS legs did
not run.

## Impact

The browser, runtime, ops, and issuer images from the target commit serve 100% of traffic. IAP was
repaired to the exact `domain:heyglide.com` accessor policy and the drained browser revision was
deleted. Discovery and JWKS are public at the deterministic issuer URL, and the runtime recovery
published one active key.

That first deployment was nevertheless not a successful release: OpenTofu did not record the
`issuer_url` output, the same plan remained blocked by the false postcondition, and the mandatory
live identity mint/revocation gate had never passed in the cloud composition.

## Follow-up release attempt

Commit `152b5c4c6320aa5d1c7d1860d70cb88873686b12` applied the URL and SSH fixes on 2026-08-26.
OpenTofu added the IAP-only firewall, recorded the deterministic `issuer_url`, and moved all four
services to the new image with zero destroys. The lifecycle smoke passed in 385 seconds. In the
identity smoke, both orbs booted, IAP SSH succeeded on its first readiness attempt, and a real token
minted inside the orb verified against the live discovery document and JWKS.

The release still failed before the stopped-orb revocation assertion. `instance_metadata` passed
`--filter` to `gcloud compute instances describe`, but `describe` is a singleton command and does
not accept the list-only filter flag. This was a deterministic smoke implementation defect, not a
product rejection: the command exited before it read the stopped orb's bearer. The failed run was
not repeated. Its disposable VMs and project were deleted, the release lock was released, all four
new revisions remained at 100% traffic, and discovery and JWKS both returned HTTP 200.

No live release has yet completed the stopped-orb revocation assertion, and the separately
bootstrapped GCP WIF tier remains unconfigured, so no live GCP STS has accepted a token from this
cloud issuer.

## Timeline (UTC)

- 16:45–16:48: OpenTofu created the issuer resources and updated browser, runtime, and ops.
- 16:47: the runtime boot hook recorded the missing-table failure while the browser migration was
  still pending.
- 16:48: the issuer `self.uri` postcondition failed; `release.sh` repaired IAP and returned failure.
- 16:49: inspection proved both issuer URLs answered, and the deterministic discovery URL was the
  advertised issuer. The full post-apply cleanup then deleted the drained browser revision.
- 16:50–16:55: the lifecycle smoke passed, including its load-bearing restart leg.
- 16:55–16:59: the workload-identity smoke booted two orbs and failed at its first SSH mint. Its
  disposable resources were deleted.
- 17:02: a same-image runtime revision reran the boot hook after migration 011 existed, recorded
  `issuer-key-activated`, and made JWKS return one active key with HTTP 200.
- 22:44–22:48: the follow-up release built commit `152b5c4`, added the IAP SSH firewall, updated all
  four services, passed the corrected issuer-URL postcondition, repaired IAP, and removed the
  drained browser revision.
- 22:48–22:55: the lifecycle smoke passed create, running, stop, restart, and final stop in 385
  seconds.
- 22:55–22:57: both identity-smoke orbs reached running; IAP SSH was ready on the first attempt; a
  token minted and verified; then the unsupported `describe --filter` invocation failed step 6.
- 22:57–22:58: cleanup deleted both disposable VMs and their project, and the release lock was
  released. The failed gate was not rerun.

## Resulting rules

- A Cloud Run issuer trust anchor is validated against the service's complete `urls` set, not by
  equality with its canonical `uri`.
- A release that introduces a schema used by a non-migrating role must establish that schema before
  the role exhausts its boot initialization; manual restart is recovery, not deployment ordering.
- A smoke path that depends on GCE SSH owns an explicit, narrowly sourced firewall rule and its
  tunnel mode. A healthy runtime does not imply that an unrelated management port is reachable.
- A singleton `gcloud ... describe` command returns JSON for local selection; list-only flags such
  as `--filter` are not composed into it. Contract coverage must preserve that command boundary.
- A failed release gate stays failed after recovery actions. Targeted checks may establish current
  service health, but they do not replace the failed end-to-end assertion.

Actionable fixes are tracked in `TODO.md`; the deployment contract is updated in
`docs/deployment.md` and `docs/workload-identity.md`.

## Remediation status

Live-validated on 2026-08-26: the issuer postcondition checks the deterministic origin's membership
in Cloud Run's complete URL set, `issuer_url` exports that trust anchor rather than the hashed
canonical URI, and the smoke reaches orb SSH through the targeted IAP-only firewall. The next source
fix makes `instance_metadata` request plain JSON from `describe` and select the requested key
locally, with contract coverage forbidding the unsupported flag. A complete fresh release remains
the acceptance gate. The migration-011 race was repaired in production and cannot recur for that
durable schema; the general schema-before-consumer release-ordering problem remains in `TODO.md`
for the next cross-role schema change.
