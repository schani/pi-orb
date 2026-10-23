import { randomUUID } from "node:crypto";
import { ResultAsync } from "neverthrow";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PgClient } from "../adapters/pg/client.ts";
import type { StoreContractSubject } from "./store-contract.ts";

/** Real node-postgres subject with an owned schema and pool-wide search_path. */
export async function openThrowawayPostgres(
  connectionString: string,
): Promise<StoreContractSubject> {
  const url = new URL(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(connectionString);
  const created = await admin.query(`CREATE SCHEMA "${schema}"`);
  if (created.isErr()) {
    await admin.end();
    created._unsafeUnwrap();
  }
  url.searchParams.set(
    "options",
    `${url.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim(),
  );
  class SubjectClient extends PgClient {
    override end() {
      return new ResultAsync(
        (async () => {
          const ended = await super.end();
          const dropped = await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          const closed = await admin.end();
          if (ended.isErr()) return ended;
          if (dropped.isErr()) return dropped.map(() => undefined);
          return closed;
        })(),
      );
    }
  }
  const client = new SubjectClient(url.toString());
  return { database: composeControlPlaneDatabase(client), client };
}
