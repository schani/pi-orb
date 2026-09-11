import { describe, expect, it } from "vitest";
import { createHostingAccessPolicy } from "./hosting-access.ts";

const configured = () =>
  createHostingAccessPolicy({
    filesOrigin: "https://files.pi-orb.example.test",
    trustedBrowserOrigins: ["http://localhost:5173", "http://vibestation:5173"],
  });

describe("hosting HTTP access policy", () => {
  it.each([
    "ftp://files.example.test",
    "https://user@files.example.test",
    "https://files.example.test/path",
    "https://files.example.test?query=yes",
    "https://files.example.test/#fragment",
  ])("rejects an invalid files origin: %s", (filesOrigin) => {
    const result = createHostingAccessPolicy({
      filesOrigin,
    });
    expect(result.isErr()).toBe(true);
  });

  it("accepts only GET and HEAD hosted paths on the files host", () => {
    const result = configured();
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    for (const method of ["GET", "HEAD"]) {
      expect(
        result.value.decide({
          method,
          path: "/s/00000000-0000-4000-8000-000000000001/design/index.html",
          host: "files.pi-orb.example.test",
        }),
      ).toEqual({ kind: "allow", surface: "hosted_read" });
    }
    expect(
      result.value.decide({
        method: "POST",
        path: "/s/00000000-0000-4000-8000-000000000001/design/index.html",
        host: "files.pi-orb.example.test",
      }),
    ).toEqual({ kind: "reject", reason: "files_method" });
  });

  it("isolates every non-file route on the files host as a safe 404", () => {
    const policy = configured()._unsafeUnwrap();
    for (const path of [
      "/",
      "/index.html",
      "/api/v1/projects",
      "/runtime/v1/tokens/model",
      "/.well-known/jwks.json",
      "/s/not-enough-segments",
    ]) {
      expect(policy.decide({ method: "GET", path, host: "files.pi-orb.example.test" })).toEqual({
        kind: "isolated_not_found",
      });
    }
    expect(
      policy.decide({
        method: "GET",
        path: "/api/v1/orbs/o/live",
        host: "files.pi-orb.example.test",
        upgrade: "websocket",
        origin: "https://files.pi-orb.example.test",
      }),
    ).toEqual({ kind: "reject", reason: "files_websocket" });
  });

  it("never serves /s paths through a non-files host", () => {
    const policy = configured()._unsafeUnwrap();
    expect(
      policy.decide({ method: "GET", path: "/s/orb/file", host: "pi-orb.example.test" }),
    ).toEqual({ kind: "reject", reason: "files_wrong_host" });
    expect(
      policy.decide({ method: "GET", path: "/s/orb/file", host: "attacker.example.test" }),
    ).toEqual({ kind: "reject", reason: "files_wrong_host" });
  });

  it("allows only the OAuth callback GET across sites, never a files-host or websocket bypass", () => {
    const policy = configured()._unsafeUnwrap();
    const request = {
      method: "GET",
      path: "/api/v1/mcp/oauth/callback?code=synthetic",
      host: "pi-orb.example.test",
      secFetchSite: "cross-site",
    };
    expect(policy.decide(request)).toEqual({ kind: "allow", surface: "app" });
    expect(policy.decide({ ...request, method: "POST" }).kind).toBe("reject");
    expect(policy.decide({ ...request, path: "/api/v1/mcp/oauth/callback/other" }).kind).toBe(
      "reject",
    );
    expect(policy.decide({ ...request, upgrade: "websocket" }).kind).toBe("reject");
    expect(policy.decide({ ...request, host: "files.pi-orb.example.test" }).kind).toBe(
      "isolated_not_found",
    );
  });

  it("allows same-origin and explicit Vite development browser requests", () => {
    const policy = configured()._unsafeUnwrap();
    for (const origin of [
      "https://pi-orb.example.test",
      "http://localhost:5173",
      "http://vibestation:5173",
    ]) {
      expect(
        policy.decide({
          method: "POST",
          path: "/api/v1/projects",
          host: "pi-orb.example.test",
          origin,
          secFetchSite: origin.startsWith("https://pi-orb") ? "same-origin" : "same-site",
        }),
      ).toEqual({ kind: "allow", surface: "app" });
    }
  });

  it("rejects files-origin and other cross-origin API and WebSocket requests", () => {
    const policy = configured()._unsafeUnwrap();
    for (const origin of [
      "https://files.pi-orb.example.test",
      "https://attacker.example.test",
    ] as const) {
      expect(
        policy.decide({
          method: "POST",
          path: "/api/v1/orbs/o/start",
          host: "pi-orb.example.test",
          origin,
          secFetchSite: "cross-site",
        }),
      ).toEqual({ kind: "reject", reason: "untrusted_origin" });
      expect(
        policy.decide({
          method: "GET",
          path: "/api/v1/orbs/o/live",
          host: "pi-orb.example.test",
          origin,
          upgrade: "websocket",
        }),
      ).toEqual({ kind: "reject", reason: "untrusted_origin" });
    }
  });

  it("rejects browser cross-site API requests even when Origin is absent", () => {
    const policy = configured()._unsafeUnwrap();
    expect(
      policy.decide({
        method: "DELETE",
        path: "/api/v1/orbs/o",
        host: "pi-orb.example.test",
        secFetchSite: "cross-site",
      }),
    ).toEqual({ kind: "reject", reason: "cross_site" });
  });

  it("preserves origin-less runtime and trusted tooling requests", () => {
    const policy = configured()._unsafeUnwrap();
    for (const request of [
      { method: "POST", path: "/runtime/v1/tokens/model", host: "pi-orb.example.test" },
      { method: "DELETE", path: "/api/v1/orbs/o", host: "pi-orb.example.test" },
      { method: "GET", path: "/.well-known/jwks.json", host: "pi-orb.example.test" },
    ]) {
      expect(policy.decide(request)).toEqual({ kind: "allow", surface: "app" });
    }
  });

  it("normalizes method, host case, and an explicit default port", () => {
    const policy = configured()._unsafeUnwrap();
    expect(
      policy.decide({
        method: "get",
        path: "/s/orb/file.txt?download=1",
        host: "FILES.PI-ORB.EXAMPLE.TEST:443",
      }),
    ).toEqual({ kind: "allow", surface: "hosted_read" });
  });

  it("derives an app origin from each raw Host when appOrigin is omitted", () => {
    const result = createHostingAccessPolicy({
      filesOrigin: "https://files.pi-orb.example.test",
      trustedBrowserOrigins: ["http://localhost:5173"],
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    for (const host of ["pi-orb.example.test", "pi-orb-alt.example.test:8443"]) {
      expect(
        result.value.decide({
          method: "POST",
          path: "/api/v1/projects",
          host,
          origin: `https://${host}`,
        }),
      ).toEqual({ kind: "allow", surface: "app" });
    }
  });

  it("rejects foreign and files origins in auto-host mode and trusts no forwarded host", () => {
    const policy = createHostingAccessPolicy({
      filesOrigin: "https://files.pi-orb.example.test",
    })._unsafeUnwrap();
    for (const origin of [
      "https://files.pi-orb.example.test",
      "https://attacker.example.test",
      "https://spoofed-forwarded-host.example.test",
    ]) {
      expect(
        policy.decide({
          method: "POST",
          path: "/api/v1/projects",
          host: "actual-app.example.test",
          origin,
        }),
      ).toEqual({ kind: "reject", reason: "untrusted_origin" });
    }
  });

  it("rejects /s on every non-files host in auto-host mode", () => {
    const policy = createHostingAccessPolicy({
      filesOrigin: "https://files.pi-orb.example.test",
    })._unsafeUnwrap();
    expect(
      policy.decide({ method: "GET", path: "/s/orb/file", host: "pi-orb-alt.example.test" }),
    ).toEqual({ kind: "reject", reason: "files_wrong_host" });
  });

  it("rejects a backslash in the raw Host header", () => {
    const policy = createHostingAccessPolicy({
      filesOrigin: "https://files.pi-orb.example.test",
    })._unsafeUnwrap();
    expect(
      policy.decide({
        method: "GET",
        path: "/api/v1/session",
        host: "pi-orb.example.test\\attacker.example.test",
      }),
    ).toEqual({ kind: "reject", reason: "invalid_host" });
  });

  it("does not treat the files hostname on another port as an app host", () => {
    const policy = createHostingAccessPolicy({
      filesOrigin: "https://files.pi-orb.example.test",
    })._unsafeUnwrap();
    expect(
      policy.decide({
        method: "GET",
        path: "/api/v1/session",
        host: "files.pi-orb.example.test:8443",
      }),
    ).toEqual({ kind: "reject", reason: "unknown_host" });
  });
});
