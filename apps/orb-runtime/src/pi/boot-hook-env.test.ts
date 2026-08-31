import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where the hooks' env file is merged is the whole feature: too early and the
 * resume hook's variables are missing, too late and the agent's session — whose
 * tool shells and PTYs inherit `process.env` — was created without them. Boot
 * has no unit-testable seam around `createAgentSession`, so the order is
 * asserted on the boot sequence itself (docs/orb-setup-hook.md).
 */
const boot = readFileSync(join(import.meta.dirname, "agent.ts"), "utf8");

const indexOf = (needle: string): number => {
  const at = boot.indexOf(needle);
  if (at < 0) throw new Error(`the boot sequence no longer contains ${needle}`);
  return at;
};

describe("the boot sequence's hook env merge", () => {
  it("fetches project secrets after identity-free setup and before resume", () => {
    const secrets = indexOf("await fetchProjectSecretSnapshotAtBoot");
    expect(indexOf("runSetup()")).toBeLessThan(secrets);
    expect(secrets).toBeLessThan(indexOf("runResume()"));
    expect(secrets).toBeLessThan(indexOf("createAgentSession({"));
  });

  it("fails readiness rather than booting with a missing or partial snapshot", () => {
    expect(boot.match(/"project_secrets_unavailable"/g)).toHaveLength(2);
  });

  it("merges the runtime's own environment after both hooks and before the session", () => {
    const merge = indexOf("applyHookEnv(process.env)");
    expect(indexOf("runSetup()")).toBeLessThan(merge);
    expect(indexOf("runResume()")).toBeLessThan(merge);
    expect(merge).toBeLessThan(indexOf("createAgentSession({"));
  });

  it("hands what it made of the file to the agent's prompt", () => {
    expect(indexOf("hookEnv,")).toBeLessThan(indexOf("createAgentSession({"));
  });
});
