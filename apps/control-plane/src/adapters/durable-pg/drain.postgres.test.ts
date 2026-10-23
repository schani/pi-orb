import { it, onTestFinished } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { assertDrainIsolation } from "./drain.contract.ts";

it("real PostgreSQL bounds stop cleanup to its storage while fencing admission, release and archive", async ({
  skip,
}) => {
  const connection = process.env.PI_ORB_DURABLE_PG_TEST_URL;
  if (!connection) return skip("needs PI_ORB_DURABLE_PG_TEST_URL");
  const { client } = await openThrowawayPostgres(connection);
  onTestFinished(async () => {
    (await client.end())._unsafeUnwrap();
  });
  await assertDrainIsolation(client);
});
