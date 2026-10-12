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

  it("keeps Claude owner management inside browser authentication and grants on runtime routes", () => {
    const browser = source.indexOf("registerAuthenticatedBrowserRoutes(");
    const claude = source.indexOf("registerClaudeAuthRoutes(browser,");
    const runtime = source.indexOf("registerRuntimeRoutes(app,");
    expect(claude).toBeGreaterThan(browser);
    expect(claude).toBeLessThan(runtime);
    expect(source).toContain(
      "claudeCredential: (task, orb) => claudeAuth.grantForOrb(task, deps.store, orb)",
    );
  });

  it("composes preview host guard, authentication and gateway before application routes", () => {
    expect(source.indexOf("registerPreviewAuth(app,")).toBeGreaterThan(
      source.indexOf("registerHostingAccessGuard(app,"),
    );
    expect(source.indexOf("registerPreviewGateway(app,")).toBeGreaterThan(
      source.indexOf("registerPreviewAuth(app,"),
    );
    expect(source.indexOf("registerPreviewGateway(app,")).toBeLessThan(
      source.indexOf("registerAuthenticatedBrowserRoutes("),
    );
    expect(source).toContain("registerRuntimePreviewRoutes(app,");
    expect(source).toContain('env("PI_ORB_PREVIEW_ORIGIN", "")');
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
