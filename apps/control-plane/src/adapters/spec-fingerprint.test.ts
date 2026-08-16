import { describe, expect, it } from "vitest";
import { specFingerprintOf } from "./spec-fingerprint.ts";

/**
 * The fingerprint must be a pure function of the *effective* specification
 * (docs/compute-replacement.md): two code paths that build the same facts in a
 * different key order must agree, or every Start replaces the whole fleet's
 * compute for no reason.
 */
describe("specFingerprintOf", () => {
  it("ignores key order, including inside nested objects", () => {
    const one = specFingerprintOf({
      image: "runtime:1",
      network: "pi-orb",
      tailscale: { hostname: "pi-orb-orb-1", previewHost: "pi-orb-orb-1.ts.net" },
    });
    const other = specFingerprintOf({
      tailscale: { previewHost: "pi-orb-orb-1.ts.net", hostname: "pi-orb-orb-1" },
      network: "pi-orb",
      image: "runtime:1",
    });
    expect(other).toBe(one);
  });

  it("ignores key order arbitrarily deep", () => {
    const one = specFingerprintOf({ a: { b: { c: 1, d: { e: 2, f: 3 } } } });
    const other = specFingerprintOf({ a: { b: { d: { f: 3, e: 2 }, c: 1 } } });
    expect(other).toBe(one);
  });

  it("ignores key order inside objects nested in arrays", () => {
    const one = specFingerprintOf({ mounts: [{ source: "vol", target: "/workspace" }] });
    const other = specFingerprintOf({ mounts: [{ target: "/workspace", source: "vol" }] });
    expect(other).toBe(one);
  });

  it("changes when any value changes", () => {
    const base = specFingerprintOf({ image: "runtime:1", extraEnv: { A: "1" } });
    expect(specFingerprintOf({ image: "runtime:2", extraEnv: { A: "1" } })).not.toBe(base);
    expect(specFingerprintOf({ image: "runtime:1", extraEnv: { A: "2" } })).not.toBe(base);
    expect(specFingerprintOf({ image: "runtime:1", extraEnv: { B: "1" } })).not.toBe(base);
    expect(specFingerprintOf({ image: "runtime:1", extraEnv: {} })).not.toBe(base);
    expect(specFingerprintOf({ image: "runtime:1", extraEnv: { A: "1" }, network: "x" })).not.toBe(
      base,
    );
  });

  it("distinguishes null, absent and empty values", () => {
    const withNull = specFingerprintOf({ tailscale: null });
    expect(specFingerprintOf({})).not.toBe(withNull);
    expect(specFingerprintOf({ tailscale: {} })).not.toBe(withNull);
    expect(specFingerprintOf({ tailscale: "" })).not.toBe(withNull);
  });

  it("distinguishes a number from its string spelling", () => {
    expect(specFingerprintOf({ size: 1 })).not.toBe(specFingerprintOf({ size: "1" }));
  });

  it("is order-sensitive for arrays", () => {
    const one = specFingerprintOf({ args: ["a", "b"] });
    expect(specFingerprintOf({ args: ["b", "a"] })).not.toBe(one);
    expect(specFingerprintOf({ args: ["a", "b"] })).toBe(one);
  });

  it("is order-sensitive for arrays of objects", () => {
    const one = specFingerprintOf({ disks: [{ name: "a" }, { name: "b" }] });
    expect(specFingerprintOf({ disks: [{ name: "b" }, { name: "a" }] })).not.toBe(one);
  });

  it("returns a stable hex digest for identical input", () => {
    const parts = { v: 1, image: "runtime:1", extraEnv: { A: "1" }, tailscale: null };
    const digest = specFingerprintOf(parts);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(specFingerprintOf({ ...parts })).toBe(digest);
  });
});
