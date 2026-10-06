import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("both runtime roles", () => {
  it("selects SDK or execution at the same image entrypoint", () => {
    const entry = readFileSync(new URL("./runtime-entry.ts", import.meta.url), "utf8");
    expect(entry).toContain('import("./execution/main.ts")');
    expect(entry).toContain('import("./main.ts")');
  });
  it("execution default port and bind support remote Docker/GCE callers", () => {
    const entry = readFileSync(new URL("./execution/main.ts", import.meta.url), "utf8");
    expect(entry).toContain('process.env.PI_ORB_RUNTIME_PORT ?? "8080"');
    expect(entry).toContain('host: "0.0.0.0"');
  });
});
