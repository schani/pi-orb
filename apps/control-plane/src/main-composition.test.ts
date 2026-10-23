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
    expect(browser).toBeGreaterThanOrEqual(0);
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(runtime).toBeGreaterThanOrEqual(0);
    expect(claude).toBeGreaterThan(browser);
    expect(claude).toBeLessThan(runtime);
    expect(source).toContain(
      "claudeCredential: (task, orb) => claudeAuth.grantForOrb(task, deps.store, orb)",
    );
  });

  it("keeps central model configuration out of compute launch inputs", () => {
    const start = source.indexOf("const runtimeExtraEnv:");
    const end = source.indexOf("const extraEnvOption");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const launchInputs = source.slice(start, end);
    for (const centralInput of [
      "mockOpenAi",
      "MOCK_OPENAI_OAUTH_URL_ENV",
      "MOCK_OPENAI_INFERENCE_URL_ENV",
      "PI_OFFLINE",
    ]) {
      expect(launchInputs).not.toContain(centralInput);
    }
  });

  it("keeps signing-key repair before activation and all autonomous loops after it", () => {
    const activation = source.indexOf("await waitForReleaseActivation(");
    const repair = source.indexOf("void ensureSigningKeyInBackground()");
    expect(repair).toBeGreaterThanOrEqual(0);
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(activation).toBeGreaterThan(repair);
    for (const loop of [
      "pollLoop",
      "reconcileLoop",
      "projectDeletionLoop",
      "orphanSweepLoop",
      "hostingCleanupLoop",
      "mcpOAuthCleanupLoop",
    ]) {
      const invocation = source.lastIndexOf(`${loop}(`);
      expect(invocation, loop).toBeGreaterThanOrEqual(0);
      expect(invocation, loop).toBeGreaterThan(activation);
    }
  });
});
