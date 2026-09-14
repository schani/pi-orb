import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { UPLOADED_SOURCE_PATHS } from "../../../packages/native-image/src/snapshot.ts";

it("includes the immutable fork artifact in both runtime installation paths", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");
  expect(dockerfile.indexOf("COPY vendor vendor")).toBeGreaterThan(-1);
  expect(dockerfile.indexOf("COPY vendor vendor")).toBeLessThan(dockerfile.indexOf("RUN npm ci"));
  expect(UPLOADED_SOURCE_PATHS).toContain("vendor");
});
