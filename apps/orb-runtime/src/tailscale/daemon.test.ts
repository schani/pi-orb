import { describe, expect, it } from "vitest";
import { tailscaleStateDir } from "./daemon.ts";

describe("tailscaleStateDir", () => {
  it("lives on the persistent volume so node identity survives replacement", () => {
    expect(tailscaleStateDir("/workspace")).toBe("/workspace/.pi-orb/tailscale");
  });
});
