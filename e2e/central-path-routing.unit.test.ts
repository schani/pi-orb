import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each([
  "durable-process.e2e.test.ts",
  "durable-independent-fixture.ts",
  "cross-axis.e2e.test.ts",
  "testkit/durable-artifact-restart.ts",
])("uses current resource paths in %s", (path) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  expect(source).not.toContain("/#/orbs/");
  expect(source).toContain("/orbs/${");
});
