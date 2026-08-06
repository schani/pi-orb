import { PREVIEW_HOST_ENV, TAILSCALE_AUTH_KEY_ENV, TAILSCALE_HOSTNAME_ENV } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { readTailscaleEnv } from "./env.ts";

const full: Record<string, string> = {
  [TAILSCALE_AUTH_KEY_ENV]: "tskey-auth-secret",
  [TAILSCALE_HOSTNAME_ENV]: "pi-orb-abc123",
  [PREVIEW_HOST_ENV]: "pi-orb-abc123.tail1234.ts.net",
};

describe("readTailscaleEnv", () => {
  it("reads the config when all three variables are present", () => {
    expect(readTailscaleEnv(full)).toEqual({
      authKey: "tskey-auth-secret",
      hostname: "pi-orb-abc123",
      previewHost: "pi-orb-abc123.tail1234.ts.net",
    });
  });

  it("is off when nothing is set", () => {
    expect(readTailscaleEnv({})).toBeNull();
  });

  it.each([TAILSCALE_AUTH_KEY_ENV, TAILSCALE_HOSTNAME_ENV, PREVIEW_HOST_ENV])(
    "is off when %s is missing",
    (missing) => {
      const partial = { ...full };
      delete partial[missing];
      expect(readTailscaleEnv(partial)).toBeNull();
    },
  );

  it.each([TAILSCALE_AUTH_KEY_ENV, TAILSCALE_HOSTNAME_ENV, PREVIEW_HOST_ENV])(
    "is off when %s is empty",
    (empty) => {
      expect(readTailscaleEnv({ ...full, [empty]: "" })).toBeNull();
    },
  );

  it("ignores unrelated variables", () => {
    expect(readTailscaleEnv({ PI_ORB_ID: "abc123", TAILSCALE_AUTH_KEY: "x" })).toBeNull();
  });
});
