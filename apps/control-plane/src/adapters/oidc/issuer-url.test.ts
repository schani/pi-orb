import { describe, expect, it } from "vitest";
import { readIssuerUrl } from "./issuer-url.ts";

/**
 * Boot validation of the issuer identity (docs/workload-identity.md). Changing
 * the URL is a breaking trust migration, so it must canonicalize to one string,
 * and a bad value must refuse boot.
 */

const LOCAL = "http://127.0.0.1:7100";

describe("readIssuerUrl", () => {
  it("canonicalizes to a bare origin so one deployment has one identity", () => {
    for (const [configured, expected] of [
      ["https://issuer.example", "https://issuer.example"],
      ["https://issuer.example/", "https://issuer.example"],
      ["https://ISSUER.example", "https://issuer.example"],
      ["https://issuer.example:443", "https://issuer.example"],
      ["https://issuer.example:8443", "https://issuer.example:8443"],
    ] as const) {
      expect(readIssuerUrl(configured, null)._unsafeUnwrap(), configured).toBe(expected);
    }
  });

  it("requires https except on loopback, where local development has no certificate", () => {
    expect(readIssuerUrl("http://127.0.0.1:7100", null)._unsafeUnwrap()).toBe(LOCAL);
    expect(readIssuerUrl("http://localhost:7100", null)._unsafeUnwrap()).toBe(
      "http://localhost:7100",
    );
    expect(readIssuerUrl("http://[::1]:7100", null)._unsafeUnwrap()).toBe("http://[::1]:7100");

    // A cleartext public issuer is trivially impersonated.
    const cleartext = readIssuerUrl("http://issuer.example", null);
    expect(cleartext.isErr()).toBe(true);
    expect(cleartext._unsafeUnwrapErr()).toContain("https:");
    expect(readIssuerUrl("ftp://issuer.example", null).isErr()).toBe(true);
  });

  it("refuses anything the well-known endpoints could not actually serve", () => {
    // The documents live at the origin root, so a path would advertise
    // endpoints that are not there rather than being silently dropped.
    for (const configured of [
      "https://issuer.example/oidc",
      "https://issuer.example/?a=b",
      "https://issuer.example/#f",
      "https://user:pass@issuer.example",
      "issuer.example",
      "/relative",
      "not a url",
    ]) {
      expect(readIssuerUrl(configured, null).isErr(), configured).toBe(true);
    }
  });

  it("falls back only where a truthful default exists", () => {
    // `role=all` serves the issuer from the process it mints in.
    expect(readIssuerUrl("", LOCAL)._unsafeUnwrap()).toBe(LOCAL);
    const missing = readIssuerUrl("", null);
    expect(missing.isErr()).toBe(true);
    expect(missing._unsafeUnwrapErr()).toContain("required");
    expect(readIssuerUrl("https://issuer.example", LOCAL)._unsafeUnwrap()).toBe(
      "https://issuer.example",
    );
  });
});
