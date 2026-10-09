import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const fixture = readFileSync(new URL("./durable-independent-fixture.ts", import.meta.url), "utf8");

it("enables IPC checkpoints in the fixture that requests forced reconciliation", () => {
  expect(fixture).toMatch(/extraEnv:\s*\{[^}]*PI_ORB_E2E_RECONCILE_CHECKPOINTS:\s*"1"/s);
});

it("inspects canonical history explicitly and uses incremental inbox polling", () => {
  expect(fixture).toContain('PI_ORB_E2E_HISTORY_INSPECTION: "1"');
  expect(fixture).toContain('"POST", `/api/v1/orbs/${orb}/messages/poll`');
  expect(fixture).not.toContain('"GET", `/api/v1/orbs/${orb}/messages`');
});

it("uses valid JavaScript regular expressions for every scripted model matcher", () => {
  for (const [, pattern] of fixture.matchAll(/regex:\s*"([^"]*)"/g)) {
    expect(() => new RegExp(pattern ?? "")).not.toThrow();
  }
});

it("retires explicit abort with public cancellation and no abort-only summary consumption", () => {
  expect(fixture).not.toMatch(/\.\.\.\(cancellation === "abort" \? \[summary\] : \[\]\)/);
  const branch = fixture.split('} else if (cancellation === "abort") {')[1]!.split("} else {")[0]!;
  expect(branch).toContain('outcome: "aborted"');
  expect(branch).toContain('outcome: "cancelled"');
  expect(branch).not.toContain("summarySettled");
});

it("owns scoped summary, model, backend wait and final commit barriers before UI assertions", () => {
  expect(fixture).not.toContain('logs.join("").includes("harness.summary_completed")');
  expect(fixture).not.toContain('split("harness.summary_completed")');
  expect(fixture).toContain('"model admission for VM_EFFECT"');
  expect(fixture).toContain('"backend execution wait publication"');
  expect(fixture).toContain('"ready tool and assistant committed"');
});

it("preserves all six existing acceptance registrations separately from followups", () => {
  const original = readFileSync(
    new URL("./durable-independent-process.e2e.test.ts", import.meta.url),
    "utf8",
  );
  for (const name of ["abort", "stop", "host-failure", "ready", "git-stop", "hook-policy"]) {
    expect(original).toContain(`"${name}"`);
  }
  const followup = readFileSync(
    new URL("./durable-resource-followup.e2e.test.ts", import.meta.url),
    "utf8",
  );
  expect(followup).toContain('registerIndependentCase("git-abort")');
  expect(followup).toContain('registerIndependentCase("artifact-restart")');
});
