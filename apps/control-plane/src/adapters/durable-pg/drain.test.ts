import { it, onTestFinished } from "vitest";
import { PGliteClient } from "../pg/pglite-client.ts";
import { assertDrainIsolation } from "./drain.contract.ts";

it("bounds stop cleanup to its storage while fencing admission, release and archive", async () => {
  const db = new PGliteClient();
  onTestFinished(async () => {
    (await db.end())._unsafeUnwrap();
  });
  await assertDrainIsolation(db);
});
