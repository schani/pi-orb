import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStartupLogger, STARTUP_PHASES } from "./startup.ts";

describe("startup breadcrumbs", () => {
  it("emits only enumerated phases and monotonic elapsed milliseconds", () => {
    let now = 100;
    const lines: string[] = [];
    const mark = createStartupLogger(
      () => now,
      (line) => lines.push(line),
    );
    mark("bootstrap.enter");
    now = 112.9;
    mark("module.enter");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "control-plane-startup", phase: "bootstrap.enter", elapsed_ms: 0 },
      { event: "control-plane-startup", phase: "module.enter", elapsed_ms: 12 },
    ]);
    expect(new Set(STARTUP_PHASES).size).toBe(STARTUP_PHASES.length);
  });

  it("does not turn a failed diagnostic write into a startup failure", () => {
    const mark = createStartupLogger(
      () => 10,
      () => {
        throw new Error("broken pipe");
      },
    );
    expect(() => mark("main.enter")).not.toThrow();
  });

  it("marks entry before Node links the main module", () => {
    const bootstrap = fileURLToPath(new URL("./startup-bootstrap.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", bootstrap, fileURLToPath(new URL("./missing-startup-main.ts", import.meta.url))],
      { encoding: "utf8", env: {} },
    );
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      event: "control-plane-startup",
      phase: "bootstrap.enter",
      elapsed_ms: expect.any(Number),
    });
    expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
  });
});
