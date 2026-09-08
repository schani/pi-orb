import { describe, expect, it } from "vitest";
import { createConfiguredHostingAccessPolicy, readHostingConfiguration } from "./hosting-config.ts";

const split = {
  PI_ORB_APP_ORIGIN: "https://app.example",
  PI_ORB_HOSTING_ORIGIN: "https://files.example",
  PI_ORB_HOSTING_STORE: "gcs",
  PI_ORB_HOSTING_BUCKET: "private-files",
};

describe("hosting boot configuration", () => {
  it("requires no hosting configuration for the public issuer", () => {
    const result = readHostingConfiguration(
      { PI_ORB_HOSTING_STORE: "unknown" },
      "issuer",
      7100,
      "/home/test",
    );
    expect(result).toEqual({ value: null });
  });

  it.each(["browser", "runtime", "ops"] as const)(
    "requires explicit split-role storage and origins for %s",
    (role) => {
      expect(readHostingConfiguration({}, role, 7100, "/home/test").isErr()).toBe(true);
      expect(readHostingConfiguration(split, role, 7100, "/home/test")).toEqual({
        value: {
          appOrigin: "https://app.example",
          filesOrigin: "https://files.example",
          store: { bucket: "private-files", kind: "gcs" },
          trustedBrowserOrigins: [],
        },
      });
    },
  );

  it("rejects unknown stores, missing GCS buckets, invalid origins, and a shared host", () => {
    expect(
      readHostingConfiguration(
        { ...split, PI_ORB_HOSTING_STORE: "s3" },
        "browser",
        7100,
        "/h",
      ).isErr(),
    ).toBe(true);
    expect(
      readHostingConfiguration(
        { ...split, PI_ORB_HOSTING_BUCKET: "" },
        "browser",
        7100,
        "/h",
      ).isErr(),
    ).toBe(true);
    expect(
      readHostingConfiguration(
        { ...split, PI_ORB_HOSTING_ORIGIN: "files.example" },
        "browser",
        7100,
        "/h",
      ).isErr(),
    ).toBe(true);
    expect(
      readHostingConfiguration(
        { ...split, PI_ORB_HOSTING_ORIGIN: "https://app.example" },
        "browser",
        7100,
        "/h",
      ).isErr(),
    ).toBe(true);
  });

  it("uses filesystem and split local origins only for the all role", () => {
    expect(readHostingConfiguration({}, "all", 7123, "/home/test")).toEqual({
      value: {
        appOrigin: "http://127.0.0.1:7123",
        filesOrigin: "http://files.localhost:7123",
        store: { kind: "filesystem", root: "/home/test/.pi-orb/hosting" },
        trustedBrowserOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
      },
    });
  });

  it("keeps app host aliases dynamic while isolating the files hostname", () => {
    const configured = readHostingConfiguration(split, "runtime", 7100, "/home/test");
    expect(configured.isOk() && configured.value !== null).toBe(true);
    if (configured.isErr() || configured.value === null) return;
    const policy = createConfiguredHostingAccessPolicy(configured.value)._unsafeUnwrap();
    expect(
      policy.decide({
        method: "POST",
        path: "/runtime/v1/hosting/files",
        host: "host.docker.internal:7100",
      }),
    ).toEqual({ kind: "allow", surface: "app" });
    expect(
      policy.decide({
        method: "GET",
        path: "/api/v1/orbs",
        host: "browser-hashed.run.app",
        origin: "https://browser-hashed.run.app",
      }),
    ).toEqual({ kind: "allow", surface: "app" });
    expect(
      policy.decide({ method: "GET", path: "/s/orb/file", host: "files.example:8443" }).kind,
    ).toBe("reject");
  });
});
