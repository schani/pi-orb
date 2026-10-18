import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("both runtime roles", () => {
  it("selects SDK or execution at the same image entrypoint", () => {
    const entry = readFileSync(new URL("./runtime-entry.ts", import.meta.url), "utf8");
    expect(entry).toContain('process.env.PI_ORB_RUNTIME_MODE ?? "execution"');
    expect(entry).toContain('mode === "claude"');
    expect(entry).toContain('import("./execution/main.ts")');
    expect(entry).toContain('import("./main.ts")');
  });
  it.each(["pi", "agent", "unknown"])("rejects runtime mode %s before boot", (mode) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./runtime-entry.ts", import.meta.url))],
      {
        env: { ...process.env, PI_ORB_RUNTIME_MODE: mode },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid PI_ORB_RUNTIME_MODE; expected claude or execution");
  });
  it("uses the same execution-default entrypoint for local development", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts.dev).toBe("node src/runtime-entry.ts");
  });
  it("execution default port and bind support remote Docker/GCE callers", () => {
    const entry = readFileSync(new URL("./execution/main.ts", import.meta.url), "utf8");
    expect(entry).toContain('process.env.PI_ORB_RUNTIME_PORT ?? "8080"');
    expect(entry).toContain('host: "0.0.0.0"');
  });
});
