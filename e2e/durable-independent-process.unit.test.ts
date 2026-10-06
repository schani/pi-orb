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

it("gives an aborted turn its own ordered summary before future input", () => {
  expect(fixture).toMatch(/\.\.\.\(cancellation === "abort" \? \[summary\] : \[\]\)/);
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
