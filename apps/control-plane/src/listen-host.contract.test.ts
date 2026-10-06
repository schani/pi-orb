import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("control-plane listen host", () => {
  it("allows a local bind without changing the cloud default", () => {
    const main = readFileSync(resolve("apps/control-plane/src/main.ts"), "utf8");

    expect(main).toContain('app.listen({ port, host: env("HOST", "0.0.0.0") })');
  });
});
