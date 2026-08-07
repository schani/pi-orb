import { expect } from "vitest";
import { storeContractTests } from "../../testkit/store-contract.ts";
import { openControlPlaneDatabase } from "../database.ts";

storeContractTests("PGlite", async () => {
  const opened = openControlPlaneDatabase({ kind: "pglite" });
  expect(opened.isOk()).toBe(true);
  return opened._unsafeUnwrap();
});
