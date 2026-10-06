import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("checks the pinned native Claude executable without authentication or inference", async () => {
  const result = await execFileAsync(process.execPath, ["infra/native-vm/claude-check.mjs"], {
    env: { PATH: process.env["PATH"] },
  });
  expect(result.stdout.trim()).toBe("CLAUDE_SDK_OK 0.3.289 / 2.1.289");
  expect(result.stderr).toBe("");
});

it("runs the Claude executable gate during image installation", async () => {
  const install = await readFile("infra/native-vm/install.sh", "utf8");
  expect(install).toContain("node infra/native-vm/claude-check.mjs");
});
