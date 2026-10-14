# Validated deployment, monitor regression — 2026-10-13

## Outcome

[Deploy 38484755289](https://github.com/schani/pi-orb/actions/runs/38484755289) validated its authoritative transaction, then completed with workflow failure from the separate monitor. Release identity, qualification and independent serving/cleanup checks: `docs/deployment.md`.

All times below are October 13, PDT (America/Los_Angeles). The monitor ran 17:41:33–17:59:57 and recorded **`regression`**: fifteen `observed` samples, health `ok` in every sample, central inference `unobserved`. Final log counts are cumulative, not sums across samples: **seven HTTP 429s, one HTTP 5xx overlapping one ERROR, zero `legacyBackend`**. Lifecycle counts were `compute-discard=1` and `compute-discard-requested=1`; neither belongs to `observe()`'s regression-trigger list. Their orb/reason were not investigated; they are not attributed to diagnostics or fixtures.

## Classified requests

- **17:42:36–17:42:48, seven POST `/runtime/v1/id-token` 429s:** each has an adjacent `identity-mint-denied code=rate_limited` edge naming our diagnostic orb, not a release fixture. Successful mints alternate with denials during verifier credential refresh. This is application enforcement of the 2,000ms per-orb floor, not evidenced Cloud Run capacity refusal. Exact initiating processes and eventual success of every denied invocation remain unproven. The current monitor flags every 429; these are not exempted or a clean observation.
- **17:31:58, historical GET `/runtime/v1/orbs/:orbId/transcript` 500:** malformed target, before the monitor window. Bounded trace/ID correlation found only the request row, no application root code or SQLSTATE. Attribution to malformed UUID coercion is inferred, not directly observed.
- **17:55:40, one synthetic invalid-ID GET:** the diagnostic agent reproduced HTTP 500 `internal`, `retryable=false` on the same serving revision, inside the monitor window. This accounts for the monitor's single 5xx/ERROR; it is separate from the historical 500. No valid resource was targeted. No failed legitimate UUID transcript read, history loss or fleet outage is established by this evidence.

These 429 and 500 counts trigger regression under the deployed policy; the two discard counts do not. Expected identity-smoke negatives were separately 403 `not_mintable` and 401, not these requests. No clean monitor, root fix, automatic rollback or gate bypass is claimed.

## Preexisting malformed-ID mechanism

The transcript handler passes an unvalidated ID to `getOrb`; PostgreSQL compares it with UUID `orbs.id`. SQLSTATE class 22 maps to store `invariant`, then HTTP 500 `internal`. The historical `22P02` remains inferred despite the reproduced response.

Git baseline `09c7c53023e7e511434bcc3a9e27957062fb3c22` and deployed `66479dffe6da964b5b2e50094a7d9852949ba213` have byte-identical runtime routes, `getOrb` and initial UUID schema. Class-22/invariant and HTTP error classification are unchanged; the client delta only adds optional SQLSTATE diagnostics. This path predates the release, not a newly introduced failure. Content-free hashes/comparison are retained locally; no root exception or transcript payload is published.

## Evidence and rule

Preserve the authoritative transaction and monitor as distinct outcomes. Healthy probes do not erase classified failures; cumulative log categories can overlap. Typed application denials are not evidence of ingress refusal without attribution. Actionable corrections live only in `TODO.md`.

Evidence under `.context/deploy-38484755289/`:

- `artifacts/{release-38484755289-1/release.json,rollout-monitor-38484755289-1/rollout-monitor.json}` and terminal `watch.log`.
- `verification/`, `warnings/` and `transcript-500/`: bounded, content-free read-only classification and the already-performed single synthetic reproduction. Their earlier pending-monitor statements retain collection-time chronology.
- `final-doc-evidence/{monitor-summary.json,baseline-comparison.json,client-diff.txt,SHA256SUMS}`: offline artifact/source review.

This finalization changed only docs and local evidence: no live reads/probes, tests, product changes, deployment or rerun. Historical release waivers remain scoped as recorded in `docs/postmortems/2026-10-13-claude-history-nul.md`; no further exception is implied.
