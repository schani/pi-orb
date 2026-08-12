# 2026-08-11 release smoke restart failed after stale-revision overlap and registry timeout

Status: root-caused from durable lifecycle events, Cloud Run revision labels, GCE guest attributes, and COS Cloud Logging. The Docker replacement remediation was implemented with contract coverage on 2026-08-11 and awaits the mandatory live release smoke; reconciler fencing and the other actionable work remain in `TODO.md`.

## Impact

Release `4ca8547` successfully updated all three Cloud Run services, restored the exact IAP policy, and deleted the previous browser revision resource, but the mandatory create → running → stop → start smoke failed. The disposable smoke orb `603315c1-784a-4492-b4aa-f82b08a3bc9d` entered `failed` with `runtime_never_answered`; the release correctly returned failure rather than claiming success. No user project was involved.

The runtime image itself was not defective. The pre-push boot gate passed, and a later boot on the same VM pulled and started the exact same digest successfully before the terminal-state backstop stopped the host.

## Timeline (UTC)

- 20:18:41 — deployment deletes old browser revision `pi-orb-00029-6hd`; the command and Cloud Audit Log both report success.
- 20:18:54–20:20:32 — new revision `00030` and the supposedly deleted old revision `00029` both reconcile the smoke orb. First boot reaches `running` on `00030`.
- 20:20:54–20:21:13 — stop is requested. Both revisions drain and issue idempotent host stops; `00029` wins the `stopped` transition.
- 20:21:15 — restart is requested.
- 20:21:50 — deleted revision `00029` starts the host with its older generation.
- 20:22:44 — revision `00030`'s concurrent start path reaches its 60-second operation deadline.
- 20:23:03 — revision `00029` issues another successful host start.
- 20:23:06 — revision `00030` repairs the host metadata forward from generation `1786321252` to `1786479403` and starts it. The forward-only script fence prevents a downgrade, but it does not prevent the old revision from performing other lifecycle actions.
- 20:23:47 — COS dockerd records the decisive failure while the repaired startup script's `docker run` implicitly pulls the new digest: `Get "https://us-central1-docker.pkg.dev/v2/": ... Client.Timeout exceeded while awaiting headers`. `docker run` exits nonzero; under `set -e` the startup script records `failed: line 29: docker run ...` and no runtime listens on port 8080.
- 20:26:06–20:26:23 — still-running deleted revision `00029` reaches its three-minute boot deadline, records 37 `ECONNREFUSED` probes, stops the host, and transitions the orb to `failed`.
- 20:26:31 — an already in-flight `00030` start completes after the durable state became `failed`.
- 20:26:53–20:27:01 — that boot pulls and starts the same runtime digest successfully, proving the earlier failure was transient registry reachability rather than a bad image.
- 20:27:24 — the terminal-state backstop observes `failed` and stops the host.

## Root cause

This was a compound failure, not a flaky smoke assertion:

1. **Deleting a Cloud Run revision resource did not promptly stop its background reconciler.** `00029` emitted lifecycle decisions until 20:26:23, 7 minutes 42 seconds after its successful deletion audit event. Revision deletion is therefore not a sufficient generation-exclusion mechanism for always-allocated background work.
2. **The generation fence is too narrow.** `ensureCurrentScript` correctly refuses to rewrite a host stamped by a newer revision, but then treats the script as current and permits the stale revision to start the host. The old revision can also run boot detection and fail durable orb state.
3. **The startup script has a one-shot destructive image update.** It removes the existing runtime container before `docker run`; `docker run` performs an implicit pull with no retry. One transient Artifact Registry timeout therefore leaves the host with no runtime and guarantees `ECONNREFUSED` until another boot.
4. **Container diagnostics were stale across boots.** The terminal error joined the current startup failure with the previous boot's `status=running ... at=20:22:19Z` reporter value. The timestamp made the evidence recoverable, but the uncorrelated status was misleading.
5. **Provider side effects can outlive their initiating state episode.** A new-revision start completed after another reconciler had transitioned the orb to `failed`; the terminal-state backstop repaired the host state later, but only after an unnecessary boot.

## Corrective direction

Tracked in `TODO.md`:

- enforce a durable active deployment/reconciler generation before every autonomous lifecycle mutation and terminal decision, rather than relying on Cloud Run revision deletion or only fencing startup-script writes;
- **implemented 2026-08-11; awaiting live release smoke:** make startup image replacement non-destructive and retryable — stop but retain the old container, pull the exact target image up to three times with bounded backoff, remove the old container only after success, and run with `--pull=never`; successful recovery and exhausted retries have shell-backed contract tests and durable guest-attribute outcomes;
- correlate startup/container evidence to the same boot attempt so stale reporter data cannot describe the current failure;
- prevent or compensate provider operations that complete after their durable state episode has ended, with DST coverage for the stale-revision and late-side-effect schedules.

The release smoke's restart leg remains load-bearing: it caught a real host lifecycle failure and must not be weakened or retried merely to obtain green.
