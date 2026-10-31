# Project search probe exceeded its client read bound

**2026-10-30, PDT. Independent probe failure; cause unresolved.**

During instrumented [Deploy 41157512677](https://github.com/schani/pi-orb/actions/runs/41157512677), the same private synthetic query with limit **3** returned orb-scope HTTP **200** (three hits, **90.8 ms**), then the project request began at **19:20:54** and hit Python's **30-second read timeout**. The matching Cloud Run request logged HTTP **200**, latency **31.46 s**. Server completion did not make the timed-out client successful. This operator bound is not a product SLO.

## Evidence and limits

Both read-only plain `EXPLAIN` plans used ordered BM25 index scans. Estimated project scope was **229 orbs**, versus **one** for orb scope; both recursive chains estimated **11** rows and used primary-key recursive joins. These estimates do not establish actual operator costs or the slow phase. Read-only activity inspection afterward found no history query in flight; none was cancelled.

No query rerun, timeout increase, waiver, `EXPLAIN ANALYZE`, forced planner, DDL or source fix followed. User-scope and negative cases were not run after failure; search is **not all-scope qualified**. Static health HTTP 200 does not prove PostgreSQL or search health. The normal Deploy and authoritative monitor subsequently passed (`docs/postmortems/2026-10-30-control-plane-startup-health-failure.md`); neither clears this independent probe failure. A later read-only check found no `pg_stat_statements` view, so statement statistics supplied no additional attribution. No root fix is claimed.

## Rule and retained evidence

Preserve the first client failure and correlate server completion separately. An ordered index plan or narrow-scope success does not qualify wider scopes. Investigation lives only in `TODO.md`.

Private originals: `~/deploy-e124/instrumented-rollout/search-smoke-first-*`. Exact plain plans and parameters remain in private `search-project-first-readonly-inspection.json`; HTTP request logs also remain private. Raw queries, hits, plans, owner/project IDs and corpus are excluded from Git.
