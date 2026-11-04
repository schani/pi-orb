import { aroundAll } from "vitest";
import { stopRepositoryFixture } from "./repository-fixture.ts";

aroundAll(async (runSuite) => {
  try {
    await runSuite();
  } finally {
    await stopRepositoryFixture();
  }
});
