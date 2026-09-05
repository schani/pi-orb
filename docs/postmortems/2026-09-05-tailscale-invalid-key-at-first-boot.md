# Tailscale key rejected at first boot — 2026-09-05

Status: provisioning race reproduced under DST and fixed locally on 2026-09-05; attribution of this live incident remains incomplete. No deployment or live repair performed.

## Confirmed evidence

Orb `f7236ad9-e976-4050-bb1e-0436fdf20fec` (Redesign Favicons and UI Icons), GCE instance `pi-orb-f7236ad9-e976-4050-bb1e-0436fdf20fec-i0`, instance ID `4254115309565370820`, zone `us-central1-a`, was created at 18:27:55 UTC. Cloud Logging `cos_containers` shows its first daemon startup at 18:29:49, generation of a new machine key at 18:29:50, and immediate registration rejection: `invalid key: API key <redacted> not valid`. All three runtime attempts failed; at 18:30:00 the runtime logged `port exposure unavailable (up_failed)` and continued booting.

The replicated transcript at 21:02 confirms `BackendState=NeedsLogin`, no Tailscale IP or current tailnet, while the localhost preview server returned HTTP 200. Thus this is failed initial enrollment, not evidence of a later logout or a problem with the user's Tailscale connection. A 90-day age expiry of a freshly minted key does not explain this timeline.

The sibling agent's diagnostic environment dump also included the orb runtime bearer and Tailscale auth key in replicated history. Do not repeat those values in diagnostic reports.

## Reproduced defect, not yet established live incident cause

The GCE provider checks instance absence, ensures the data disk, mints a key (revoking earlier exact-orb keys), then inserts the VM. A competing provisioner can pass the absence check before that insert, revoke the winning VM's key during its own mint, receive insert conflict, and adopt the winning VM without replacing its now-revoked key. The adapter's process-local serialization does not make the entire cross-process provision transaction atomic. The composed simulation below proves this ordering is an actual defect in the real adapters, not just a code-reading hypothesis. The incident's actual competing calls and Tailscale revocation history have not been correlated.

## Why the original tests missed the race

Inspected 2026-09-05: `apps/control-plane/src/adapters/gce/model.dst.test.ts` constructs the real GCE provider without Tailscale options. The scheduled GCE world therefore performs no key mint/revocation or enrollment. `docs/compute-replacement.md` explicitly scoped Tailscale outside DST.

The separate `provider.test.ts` create-conflict test uses scripted HTTP responses with Tailscale disabled and checks adoption of the winner's runtime-token hash. The original Tailscale `client.test.ts` concurrency test used one minter, two different incarnations, and real `setTimeout(1)` delays (now replaced with a deterministic microtask yield); it checks that only the newest key survives, not that the surviving VM holds that key. These isolated assertions can all pass while a competing mint invalidates the winner's enrollment authority. This is a model-composition and invariant gap, not evidence that more seeds would find the race.

Implemented in `apps/control-plane/src/adapters/gce/enrollment.dst.test.ts`: real GCE and Tailscale adapters over shared stateful simulated services, independent provisioner/minter instances racing on the same incarnation, with scheduled transport boundaries through absence checks, revoke/mint, insert conflict, and winner adoption. A modeled guest then consumes the metadata key and resumes retained identity; assertions also verify cleanup and sanitized lifecycle key events. This tests enrollment semantics, not the actual Tailscale daemon or external API.

## Reproduction and fix

Both the forced delayed-loser scenario and unconstrained entropy failed at iteration 0 before the production change. The trace records: both GETs return 404; A mints key 1 and inserts successfully; B revokes key 1, mints key 2, loses insert with 409, and adopts A's VM; enrollment with the metadata key fails. Traces were explicitly replayed before fixing the code:

- `test-failures/gce-enrollment-forced-losing-mint-1788648093474-0.json` — original enrollment failure; exact replay passes after the fix.
- `test-failures/gce-enrollment-entropy-1788648145352-0.json` — independent entropy enrollment failure; pre-fix replay reproduced. Later model-visibility correction changes the path and makes this old trace diverge, rather than claiming an exact passing replay.

Harness findings, also preserved rather than rerun away:

- `test-failures/gce-enrollment-entropy-1788648102700-0.json` — the first entropy attempt exhausted five 1 ms retries before the winner's 1,000 ms operation poll. Explicit replay identified a scenario synchronization error; the retry now waits for modeled operation completion, not an arbitrary retry count.
- `test-failures/gce-model-late-stale-discard-1788648270691-27.json` — an intermediate GCE-model change reserved accepted names but still hid metadata until the initiating caller polled completion. A deadline-abandoned create then left every retry seeing 404/409. Explicit replay reproduced; accepted resources now expose winning metadata immediately, while asynchronous completion advances their status. Contract tests verify accepted-name conflict, winning-body retention, and completion after caller loss. The corrected path diverges from this old trace at the successful store commit. No product timeout or assertion was weakened.

Fix: `HttpTailscaleAuthKeyMinter` revokes only strictly older-incarnation keys during mint; same/newer-incarnation keys survive. Deletion-grade cleanup continues to revoke all exact-orb keys. Both list descriptions and detail-fetch descriptions use the same fence. `apps/control-plane/src/adapters/tailscale/model.dst.test.ts` also schedules an older minter after a newer mint and verifies newer enrollment plus subsequent older-key collection. Production wiring records mint/preserve/revoke decisions as sanitized `lifecycle:` events with orb, requested incarnation, and API key ID, never the secret.

The previous at-most-one-outstanding-key requirement is rejected: it was not atomically enforceable by a revoke-all-before-create sequence. Same-incarnation losing attempts can leave unused non-reusable keys until expiry, higher-incarnation collection, or deletion. This trade-off preserves potentially installed authority; it does not claim a cardinality bound or distributed locking. Full rationale is in `docs/ports.md`.

Validation: focused GCE/Tailscale/model suite passed 66 tests, including 50 schedules each for forced creation, entropy creation, and delayed older mint; typecheck and repository lint passed. The initial full unit run passed 1,062 tests with five release-script failures caused by absent `jq`; after installing that prerequisite the release contract file passed all eight tests. Final repository validation passed typecheck, lint, and the complete unit suite: 1,067 passed, one intentionally skipped. No E2E or deployment was performed; runtime/protocol code is unchanged. The original failure logs and traces remain preserved.

## Recovery and product implications

A fresh, narrowly scoped enrollment key and successful reauthentication can restore the existing orb without deleting its workspace. Ordinary stop/start reuses VM metadata and therefore is not a reliable key repair. Compute-only replacement can obtain a fresh incarnation key while retaining the workspace, but must not be confused with destructive orb deletion.

Port exposure can remain optional without advertising an unverified working connection. The current prompt depends on configuration rather than enrollment success, and runtime health deliberately ignores Tailscale failure. Repairs need actual tailnet-side HTTP verification, not localhost alone. Remaining live investigation, recovery, safe surplus-key reclamation, and visible status work are tracked in `TODO.md`.

Direct guest inspection through `gcloud compute ssh` was blocked by missing metadata-write permission for the investigating service account; no IAM grants were broadened.
