# MCP audit-generation test mismatch (2026-09-27)

The cf49a15 qualification PostgreSQL run passed 98 tests and failed one: `mcp-oauth.test.ts` expected numeric `generation: 2` from a raw audit query but received string `"2"`. First failure: `.context/consolidation/preparation-20260927/qualification-cf49a15/postgres.log`.

`mcp_oauth_events.generation` is `bigint` (`018_mcp_oauth.sql`). The default node-postgres int8 parser returns strings; PGlite returns numbers. The store CAS result and submitted diagnostic generation were correct. This was a test assertion on driver representation, not a product failure.

The audit query now selects `generation::text AS generation` and asserts `"2"`; the store CAS assertion remains numeric `2` and the diagnostic detail assertion remains exact. No global type parser or product conversion changed.

Both backends passed all five tests in the affected file: owned PostgreSQL via `run-guarded.py` and PGlite without `PI_ORB_TEST_DATABASE_URL`. Logs and exit codes: `.context/consolidation/preparation-20260927/pg-test-repair/`. The original failure remains preserved; broader qualification was not rerun here.
