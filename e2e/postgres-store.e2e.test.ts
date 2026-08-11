import { afterAll, beforeAll, describe, it } from "vitest";
import { openThrowawayPostgres } from "../apps/control-plane/src/testkit/postgres.ts";
import { storeContractTests } from "../apps/control-plane/src/testkit/store-contract.ts";
import { docker, waitFor } from "./harness.ts";

/**
 * The store contract against a real PostgreSQL server, over the same
 * node-postgres driver production uses.
 *
 * This is the gate the incident in
 * `docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md` was missing:
 * every store test ran on PGlite, which binds parameters by OID and therefore
 * accepted a `jsonb` parameter that node-postgres encoded as a PostgreSQL
 * array literal — 100% of message enqueues failed in production while the
 * suite was green.
 *
 * `PI_ORB_TEST_DATABASE_URL` (a throwaway database — each test drops and
 * recreates schema `public`) replaces the container; the Docker-free
 * `PI_ORB_E2E_BACKEND=process` gate skips this file unless that variable
 * supplies a server.
 */
const PG_CONTAINER = "pi-orb-e2e-store-pg";
const PG_PORT = 55_434;
const providedUrl = process.env["PI_ORB_TEST_DATABASE_URL"] ?? "";
const PROCESS_BACKEND = process.env["PI_ORB_E2E_BACKEND"] === "process";
let connectionString = providedUrl;

if (providedUrl === "" && PROCESS_BACKEND) {
  describe("node-postgres store contract", () => {
    it.skip("needs Docker or PI_ORB_TEST_DATABASE_URL; the process backend supplies neither", () => {
      // Registered as skipped so the missing coverage is visible in the run.
    });
  });
} else {
  if (providedUrl === "") {
    beforeAll(async () => {
      await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
      await docker([
        "run",
        "--detach",
        "--name",
        PG_CONTAINER,
        "-e",
        "POSTGRES_USER=pi-orb",
        "-e",
        "POSTGRES_PASSWORD=pi-orb",
        "-e",
        "POSTGRES_DB=pi_orb",
        "-p",
        `127.0.0.1:${PG_PORT}:5432`,
        "postgres:16",
      ]);
      await waitFor(
        "store-contract postgres ready",
        async () => {
          const out = await docker(["exec", PG_CONTAINER, "pg_isready", "-U", "pi-orb"]);
          return out.includes("accepting connections") ? true : null;
        },
        { timeoutMs: 60_000 },
      );
      connectionString = `postgres://pi-orb:pi-orb@127.0.0.1:${PG_PORT}/pi_orb`;
    }, 120_000);

    afterAll(async () => {
      await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
    });
  }

  storeContractTests("node-postgres (real server)", () => openThrowawayPostgres(connectionString));
}
