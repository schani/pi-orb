import { describe, expect, it } from "vitest";
import { formatProjectSecretCount } from "./project-secret-metadata.ts";

describe("formatProjectSecretCount", () => {
  it("formats configured counts and loading/failure fallbacks", () => {
    expect(formatProjectSecretCount(undefined)).toBe("secrets");
    expect(formatProjectSecretCount(null)).toBe("secrets unavailable");
    expect(formatProjectSecretCount(0)).toBe("no secrets configured");
    expect(formatProjectSecretCount(1)).toBe("1 secret configured");
    expect(formatProjectSecretCount(3)).toBe("3 secrets configured");
  });
});
