import { describe, expect, it } from "vitest";
import { isDigestPinnedImage } from "./image-pin.ts";

const digest = "a".repeat(64);

/**
 * This predicate is the only thing standing between a moving tag and a host
 * whose contents change without its spec fingerprint changing — which would
 * silently defeat immutable replacement (docs/compute-replacement.md). Its
 * exact accept/reject boundary is therefore contract, not detail.
 */
describe("isDigestPinnedImage", () => {
  it("accepts a digest reference with or without a tag", () => {
    expect(isDigestPinnedImage(`ghcr.io/o/pi-orb-runtime@sha256:${digest}`)).toBe(true);
    expect(isDigestPinnedImage(`ghcr.io/o/pi-orb-runtime:v1.2.3@sha256:${digest}`)).toBe(true);
    expect(isDigestPinnedImage(`pi-orb-runtime@sha256:${digest}`)).toBe(true);
    expect(
      isDigestPinnedImage(`europe-west4-docker.pkg.dev/p/r/runtime:dev@sha256:${digest}`),
    ).toBe(true);
    expect(
      isDigestPinnedImage(`registry:5000/o/runtime@sha256:${"0123456789abcdef".repeat(4)}`),
    ).toBe(true);
  });

  it("rejects a tag-only or digest-free reference", () => {
    expect(isDigestPinnedImage("ghcr.io/o/pi-orb-runtime:dev")).toBe(false);
    expect(isDigestPinnedImage("ghcr.io/o/pi-orb-runtime:latest")).toBe(false);
    expect(isDigestPinnedImage("pi-orb-runtime")).toBe(false);
    expect(isDigestPinnedImage("")).toBe(false);
  });

  it("rejects a malformed or truncated digest", () => {
    expect(isDigestPinnedImage(`runtime@sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isDigestPinnedImage(`runtime@sha256:${"a".repeat(65)}`)).toBe(false);
    expect(isDigestPinnedImage("runtime@sha256:")).toBe(false);
    expect(isDigestPinnedImage("runtime@sha256:abcdef")).toBe(false);
    // Hex only: a `g` is not a digest character even at full length.
    expect(isDigestPinnedImage(`runtime@sha256:${"a".repeat(63)}g`)).toBe(false);
    // A different algorithm prefix is not the one the composition asserts.
    expect(isDigestPinnedImage(`runtime@sha512:${digest}`)).toBe(false);
    expect(isDigestPinnedImage(`runtime@${digest}`)).toBe(false);
  });

  it("requires the digest to end the reference", () => {
    expect(isDigestPinnedImage(`runtime@sha256:${digest} `)).toBe(false);
    expect(isDigestPinnedImage(`runtime@sha256:${digest}\n`)).toBe(false);
    expect(isDigestPinnedImage(`runtime@sha256:${digest}:tag`)).toBe(false);
    expect(isDigestPinnedImage(`runtime@sha256:${digest} && rm -rf /`)).toBe(false);
  });

  it("accepts uppercase hex, which registries never emit but the regex allows", () => {
    // Asserting current behavior: the check is case-insensitive, so an
    // uppercase digest passes even though a registry would reject it later.
    expect(isDigestPinnedImage(`runtime@sha256:${"A".repeat(64)}`)).toBe(true);
    expect(isDigestPinnedImage(`runtime@SHA256:${digest}`)).toBe(true);
  });
});
