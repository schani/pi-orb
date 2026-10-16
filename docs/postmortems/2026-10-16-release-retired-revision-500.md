# Release smoke: HTTP 500 attributed to a retired revision

2026-10-16; times PDT (UTC−07:00). [Deploy 38961777202](https://github.com/schani/pi-orb/actions/runs/38961777202), main `e6710059313ceb8b90ad363acc61ca62297717ec`, failed **after activation**; this source excludes the local Claude fairness patch.

At **14:04:19.004801**, fixture GET `/api/v1/orbs/a589d6ce-fa69-42c9-9a6e-07484934a05f` received HTTP 500, attributed by Cloud Run to already-deleted `pi-orb-issuer-00060-kfk`, with zero logged latency. The release log records its deletion at **13:58:04**. The response body/Content-Type were not retained; the internal routing cause is **unproven**.

Serving `pi-orb-issuer-00061-m4d` was Ready with 100% traffic. The fixture reached running about **0.52 s** after the failed GET; this does not clear the failed smoke. The bounded minute contains four old-revision HTTP 500s and no serving-revision HTTP errors; it does not establish a platform root cause.

Private first-failure logs, release artifact, request/revision/fixture captures and checksums: `/workspace/evidence/c9a30a6d/release-smoke-38961777202/`. No rerun, redeploy, cleanup or fix is claimed; the running fixture is preserved and is not owned by this recovery task.

**Narrow exception — user-approved 2026-10-16:** explanation of this recorded historical HTTP 500 is not a merge/deployment requirement. First-failure evidence and the failed gate remain retained; no cause or fix is claimed. The exception does not cover c9’s unexplained unreachability or any future HTTP 500. Current/exact-head qualification, new-failure handling, DST replay/root-cause requirements, assertions and verified fixture cleanup are unchanged. Normal release gates still apply; no operator bypass, merge or deployment is authorized here. Policy: `AGENTS.md`; qualification: `docs/testing.md`.
