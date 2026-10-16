import { resolve } from "node:path";
import { resolveConfig } from "vite";
import { expect, it } from "vitest";

it("keeps the production JavaScript and CSS browser targets", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const config = await resolveConfig(
    { root, configFile: resolve(root, "vite.config.ts") },
    "build",
  );
  const target = ["chrome107", "edge107", "firefox104", "safari16"];
  expect(config.build.target).toEqual(target);
  expect(config.build.cssTarget).toEqual(target);
});
