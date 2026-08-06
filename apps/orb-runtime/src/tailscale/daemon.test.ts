import { describe, expect, it } from "vitest";
import { tailscaleStateDir } from "./daemon.ts";

describe("tailscaleStateDir", () => {
  it("lives on the persistent volume so node identity survives replacement", () => {
    expect(tailscaleStateDir("/workspace")).toBe("/workspace/.pi-orb/tailscale");
  });

  it("cannot collide with the checkout or the clone staging dir", () => {
    // agent.ts clones into `<workDir>/.clone-tmp` (removed wholesale on every
    // fresh clone) and renames it onto `<workDir>/repo`.
    const stateDir = tailscaleStateDir("/workspace");
    for (const reserved of [
      "/workspace/repo",
      "/workspace/.clone-tmp",
      "/workspace/pi-sessions",
      "/workspace/pi-agent",
      "/workspace/pi-auth.json",
    ]) {
      expect(stateDir.startsWith(`${reserved}/`)).toBe(false);
      expect(stateDir).not.toBe(reserved);
    }
  });
});
