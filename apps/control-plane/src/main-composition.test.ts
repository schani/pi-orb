import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("single control-plane composition", () => {
  it("makes the development command explicitly local", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts.dev).toContain("PI_ORB_AUTH_MODE=local");
  });
  it("has one composition instead of role-gated routes or autonomous work", () => {
    expect(source).not.toContain("PI_ORB_ROLE");
    expect(source).toContain('app.get("/health",');
    expect(source).not.toMatch(/\b(?:browserRole|runtimeRole|issuerRole|opsRole)\b/u);
    for (const route of [
      "registerRuntimeRoutes",
      "registerIssuerRoutes",
      "registerAuthenticatedBrowserRoutes",
      "registerAuthRoutes",
    ]) {
      expect(source).toContain(`${route}(`);
    }
  });

  it("keeps signing-key repair before activation and all autonomous loops after it", () => {
    const activation = source.indexOf("await waitForReleaseActivation(");
    expect(activation).toBeGreaterThan(source.indexOf("void ensureSigningKeyInBackground()"));
    for (const loop of [
      "pollLoop",
      "reconcileLoop",
      "projectDeletionLoop",
      "orphanSweepLoop",
      "hostingCleanupLoop",
      "mcpOAuthCleanupLoop",
    ]) {
      expect(source.lastIndexOf(`${loop}(`)).toBeGreaterThan(activation);
    }
  });
});
