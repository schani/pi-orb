import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("qualifies the installed fork and real Pi runtime adapter through eleven gated schedules", async () => {
  const script = fileURLToPath(
    new URL("../../../../scripts/subagent-liveness/liveness.test.mjs", import.meta.url),
  );
  const controller = new AbortController();
  const child = spawn(process.execPath, ["--test", script], {
    env: { ...process.env, USE_RUNTIME: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    signal: controller.signal,
    killSignal: "SIGKILL",
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => controller.abort(), 170_000);
  const outcome = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    let error: string | undefined;
    child.once("error", (cause) => {
      error = String(cause);
    });
    child.once("close", (code) => resolve({ code, ...(error ? { error } : {}) }));
  });
  clearTimeout(timer);
  expect(outcome, output).toEqual({ code: 0 });
  expect(output).toContain("assert:cancelled-startup-executes-zero-work");
  expect(output).toContain("assert:whole-operation-abort-does-not-wake-parent");
  expect(output).toContain("assert:explicit-resume-owns-fresh-cancellation-and-operation");
  expect(output).toContain("assert:child-refreshes-through-inherited-broker");
  expect(output).toContain("assert:child-credential-failure-does-not-replay-work");
  expect(output).toContain("assert:root-inline-extension-not-inherited");
  expect(output).toContain("assert:shutdown-awaits-child-cleanup");
  expect(output).toContain("assert:one-summary-includes-aggregate-outcomes");
}, 180_000);
