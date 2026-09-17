import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { credentialPointerMigrationContractTests } from "../apps/control-plane/src/adapters/pg/credential-pointers-migration.contract.ts";
import {
  hostingStoreContractTests,
  postgreSQLHostingContractSubject,
} from "../apps/control-plane/src/adapters/pg/hosting.contract.ts";
import { PostgreSQLHostingStore } from "../apps/control-plane/src/adapters/pg/hosting.ts";
import { openThrowawayPostgres } from "../apps/control-plane/src/testkit/postgres.ts";
import { storeContractTests } from "../apps/control-plane/src/testkit/store-contract.ts";
import { parseDockerLoopbackPort } from "./docker-port.ts";
import { docker, waitForPostgres } from "./harness.ts";

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
const PG_CONTAINER = `pi-orb-e2e-store-pg-${randomUUID()}`;
const providedUrl = process.env["PI_ORB_TEST_DATABASE_URL"] ?? "";
const PROCESS_BACKEND = process.env["PI_ORB_E2E_BACKEND"] === "process";
let connectionString = providedUrl;
let containerId: string | null = null;

if (providedUrl === "" && PROCESS_BACKEND) {
  describe("node-postgres store contract", () => {
    it.skip("needs Docker or PI_ORB_TEST_DATABASE_URL; the process backend supplies neither", () => {
      // Registered as skipped so the missing coverage is visible in the run.
    });
  });
} else {
  if (providedUrl === "") {
    beforeAll(async () => {
      containerId = await docker([
        "create",
        "--name",
        PG_CONTAINER,
        "-e",
        "POSTGRES_USER=pi-orb",
        "-e",
        "POSTGRES_PASSWORD=pi-orb",
        "-e",
        "POSTGRES_DB=pi_orb",
        "-p",
        "127.0.0.1::5432",
        "postgres:16",
      ]);
      await docker(["start", containerId]);
      const port = parseDockerLoopbackPort(await docker(["port", containerId, "5432/tcp"]));
      // Vitest setup failures are exceptions; never connect through an unvalidated mapping.
      if (port.isErr())
        throw new Error("Docker did not publish one valid loopback PostgreSQL port");
      console.info(
        JSON.stringify({
          event: "postgres-fixture-bound",
          container: containerId,
          name: PG_CONTAINER,
          port: port.value,
        }),
      );
      await waitForPostgres(containerId, "pi-orb", "pi_orb", "store-contract postgres ready");
      connectionString = `postgres://pi-orb:pi-orb@127.0.0.1:${port.value}/pi_orb`;
    }, 120_000);

    afterAll(async () => {
      if (containerId !== null) await docker(["rm", "-f", containerId]);
    });
  }

  credentialPointerMigrationContractTests("node-postgres (real server)", async () => {
    const subject = await openThrowawayPostgres(connectionString);
    return subject.client;
  });
  storeContractTests("node-postgres (real server)", () => openThrowawayPostgres(connectionString));
  hostingStoreContractTests("node-postgres (real server)", async () => {
    const subject = await openThrowawayPostgres(connectionString);
    return postgreSQLHostingContractSubject(
      subject.client,
      new PostgreSQLHostingStore(subject.client),
      async () => {
        await subject.database.close();
      },
    );
  });
}
