import { describe, expect, it } from "vitest";
import { createPreviewHosts, orbFilesBaseUrl } from "./preview-host.ts";

const orb = "12345678-1234-4234-8234-123456789abc";
const config = {
  previewOrigin: "https://preview.example.net",
  appOrigin: "https://app.example.com",
  filesOrigin: "https://files.example.org",
};
describe("preview hosts", () => {
  it("constructs and parses only canonical orb/port authorities", () => {
    const hosts = createPreviewHosts(config)._unsafeUnwrap();
    expect(hosts.url(orb, 5173)._unsafeUnwrap()).toBe(`https://p5173-o${orb}.preview.example.net`);
    expect(hosts.parse(`p5173-o${orb}.preview.example.net`)).toEqual({
      orbId: orb,
      port: 5173,
      origin: `https://p5173-o${orb}.preview.example.net`,
    });
    for (const host of [
      `p05173-o${orb}.preview.example.net`,
      `p0-o${orb}.preview.example.net`,
      `p65536-o${orb}.preview.example.net`,
      `p5173-o${orb.toUpperCase()}.preview.example.net`,
      `p5173-o${orb}.preview.example.net.evil.com`,
      `p5173-o${orb}.preview.example.net:443`,
      `p5173-o${orb}.preview.example.net.`,
      "evil.test",
    ])
      expect(hosts.parse(host)).toBeUndefined();
    expect(hosts.url(orb, 1.5).isErr()).toBe(true);
  });
  it("isolates registration-free file origins and omits them for unsupported providers", () => {
    const hosts = createPreviewHosts(config)._unsafeUnwrap();
    const origin = `https://f-o${orb}.preview.example.net`;
    expect(hosts.files.url(orb)._unsafeUnwrap()).toBe(origin);
    expect(hosts.files.parse(new URL(origin).host)).toEqual({ orbId: orb, origin });
    expect(hosts.parse(new URL(origin).host)).toBeUndefined();
    for (const host of [
      `f-o${orb.toUpperCase()}.preview.example.net`,
      `f-o${orb}.preview.example.net:443`,
      `f-o${orb}.preview.example.net.attacker.test`,
    ])
      expect(hosts.files.parse(host)).toBeUndefined();
    expect(orbFilesBaseUrl(hosts, "docker", orb)).toBe(origin);
    expect(orbFilesBaseUrl(hosts, "gce", orb)).toBe(origin);
    expect(orbFilesBaseUrl(hosts, "process", orb)).toBe(origin);
    expect(orbFilesBaseUrl(hosts, "unknown", orb)).toBeNull();
    expect(orbFilesBaseUrl(undefined, "docker", orb)).toBeNull();
  });
  it("requires exact HTTPS origin and isolated PSL registrable domain", () => {
    for (const previewOrigin of [
      "https://x.example.com",
      "https://x.example.org",
      "https://a.co.uk",
      "https://preview.example.net/",
      "https://preview.example.net/path",
      "https://user@preview.example.net",
      "http://preview.example.net",
      "https://preview.example.net:443",
    ])
      expect(
        createPreviewHosts({
          ...config,
          previewOrigin,
          ...(previewOrigin === "https://a.co.uk" ? { appOrigin: "https://b.a.co.uk" } : {}),
        }).isErr(),
      ).toBe(true);
    const local = createPreviewHosts({
      ...config,
      previewOrigin: "http://preview.localhost:3000",
      local: true,
    })._unsafeUnwrap();
    expect(orbFilesBaseUrl(local, "process", orb)).toBe(`http://f-o${orb}.preview.localhost:3000`);
    expect(createPreviewHosts({ ...config, previewOrigin: local.baseOrigin }).isErr()).toBe(true);
    expect(
      createPreviewHosts({
        ...config,
        previewOrigin: "http://preview.example.net",
        local: true,
      }).isErr(),
    ).toBe(true);
    expect(
      createPreviewHosts({
        ...config,
        previewOrigin: "https://a.github.io",
        appOrigin: "https://b.github.io",
      }).isOk(),
    ).toBe(true);
  });
});
