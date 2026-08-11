# 2026-08-11 — every send-anytime enqueue failed on production PostgreSQL, invisible to the PGlite-only store tests

Status: root-caused and fixed in the working tree.

**Field finding: `enqueueOrbMessage` bound the message content array straight to the `content jsonb` column. node-postgres serializes a JavaScript array as a PostgreSQL *array literal*, not as JSON, so every insert failed with SQLSTATE 22P02 `invalid input syntax for type json` — 100% of message submissions on real PostgreSQL. Every store test runs on PGlite, which serializes parameters by parameter OID and therefore accepted the same value, so the suite was green. The error classifier then mapped the permanent failure to `unavailable`/`retryable: true`, so the API answered 503 "retry me" and clients re-sent forever.**

## What happened

`INSERT INTO orb_messages (..., content, ...) VALUES ($1,$2,$3,...)` passed `params.content` — a `[{ type: "text", text: … }]` array — as `$3`.

- **node-postgres** (`pg`) decides the wire encoding from the *JavaScript value*: `prepareValue` sends a plain object as `JSON.stringify(value)` but an array through `arrayString()`, producing `{"{\"type\":\"text\"…}"}`. PostgreSQL parses that against `jsonb` and raises 22P02.
- **PGlite** decides from the *parameter OID* the server reports for the placeholder, so for a `jsonb` parameter it JSON-encodes the array correctly.

Two pre-existing `jsonb` parameters (`orbs.harness_session_header`, `history_records.record`) were object-shaped, so `pg` stringified them and they worked — which is exactly why nobody suspected the binding layer. The divergence is invisible in SQL text: the same statement, the same schema, the same store code, and two different results per driver.

The second defect compounded it. `mapPgError` classified everything outside `{23503, 23505, 23514}` as `{ code: "unavailable", retryable: true }`. A deterministic encoding bug was therefore advertised to the browser as a transient outage (HTTP 503, `retryable: true`), and the reconcile/poll loops would have retried it until a deploy.

## Root cause

Three independent gaps, all necessary:

1. **The parameter's intent was implicit.** The value alone cannot express "this goes into a `jsonb` column" versus "this is a PostgreSQL array", and the two drivers guess differently.
2. **The store's only test substrate was PGlite.** It shares the migrations and the SQL text with production but not the driver, and parameter binding lives in the driver. `docs/testing.md` claimed the PGlite E2E leg "exercises the same PostgreSQL migrations and store SQL as production", which is true and insufficient.
3. **The error classifier defaulted to retryable.** Unknown SQLSTATE meant "outage", so a permanent bug looked like a blip both to clients and to our own loops.

## Fix and invariant

- **Structured parameters must declare their intent.** `jsonParam()` and `arrayParam()` (`apps/control-plane/src/adapters/pg/client.ts`) wrap the value; each client unwraps for its own driver (`JSON.stringify` for node-postgres, raw for PGlite, which would double-encode a pre-stringified value). `jsonParam(null)` binds SQL NULL, never `'null'::jsonb`.
- **The hazard is now deterministic.** A shared prepare step runs before every driver call, in both clients and inside transactions, and refuses any remaining bare array or bare plain-object parameter with a `StoreError` naming the placeholder — identically under PGlite, in-memory tests, and real PostgreSQL. The bug can no longer be driver-dependent.
- **`invariant` is a first-class store-error class.** SQLSTATE classes `22` (data exception) and `42` (syntax/undefined object), plus the guard, produce `code: "invariant", retryable: false`. It maps to a non-retryable HTTP 500 `internal` (never 503), and the reconcile/poll/project-deletion loops park the subject after one edge-logged `invariant=true` line instead of retrying a bug forever. The park is process-local, so a deploy with the fix resumes normally.
- **PGlite is not a faithful stand-in for node-postgres parameter binding.** The store contract suite now runs against a real PostgreSQL server too: `e2e/postgres-store.e2e.test.ts` provisions `postgres:16` in the E2E run, and `PI_ORB_TEST_DATABASE_URL` runs the identical contract from the unit suite. Verified against the reintroduced bug: 6 of 15 contract tests fail on the real server while PGlite stays green.

Rules recorded in `docs/testing.md` (test substrate + parameter convention) and `docs/lifecycle.md` (loops never retry an `invariant`).
