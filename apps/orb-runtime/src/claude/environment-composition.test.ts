import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { err, ok, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { environmentPrompt } from "../environment-prompt.ts";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { claudeEnvironmentPrompt } from "./environment-prompt.ts";

vi.mock("../domain/checkout.ts", () => ({ prepareCheckout: () => okAsync("commit") }));
vi.mock("../domain/home.ts", () => ({ configurePersistentHome: (dir: string) => ok(dir) }));
vi.mock("../domain/rust.ts", () => ({ configurePersistentRust: () => {} }));
vi.mock("./execution-identity.ts", () => ({ readExecutionIdentity: () => ok(null) }));
vi.mock("../git-identity/apply.ts", () => ({ applyGitIdentity: () => okAsync(undefined) }));
vi.mock("../project-secrets/endpoint.ts", () => ({
  fetchProjectSecretSnapshotAtBoot: () => okAsync({ values: {} }),
}));
vi.mock("../mcp/boot.ts", () => ({ fetchMcpCatalog: () => okAsync({ servers: [] }) }));
vi.mock("../personal-instructions/endpoint.ts", () => ({
  fetchPersonalInstructions: () => okAsync({ content: "PERSONAL", revision: 1 }),
}));
vi.mock("../project-instructions/endpoint.ts", () => ({
  fetchProjectInstructions: () => okAsync({ content: "PROJECT", revision: 1 }),
}));
vi.mock("./boot-context.ts", () => ({
  fetchBootContext: () => okAsync({ context: null, userTimeZone: "America/Los_Angeles" }),
}));
vi.mock("./auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.ts")>()),
  fetchClaudeSubscription: () => okAsync({ token: "test-token", generation: 1 }),
}));

it("appends the shared environment then Claude suffix exactly once before existing context", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-environment-"));
  mkdirSync(join(workDir, "repo"));
  const options: Options[] = [];
  const previewHost = "pi-orb-test.tail1234.ts.net";
  const agent = new ClaudeOrbAgent({
    orbId: "orb",
    repositoryUrl: "https://example.com/repo",
    workDir,
    skillsDir: null,
    previewHost,
    broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
    sdkFactory: (_input, value) => {
      options.push(value);
      return err({ message: "Captured model configuration; no process started." });
    },
  });
  try {
    await agent.boot();
    expect(options).toHaveLength(1);
    const system = options[0]?.systemPrompt;
    expect(system).toEqual({
      type: "preset",
      preset: "claude_code",
      append: [
        environmentPrompt,
        claudeEnvironmentPrompt,
        "PERSONAL",
        "PROJECT",
        portExposurePrompt(previewHost),
        "User's time zone: America/Los_Angeles.",
      ].join("\n\n"),
    });
    const append = typeof system === "object" && "append" in system ? (system.append ?? "") : "";
    expect(append.split(environmentPrompt)).toHaveLength(2);
    expect(append.split(claudeEnvironmentPrompt)).toHaveLength(2);
    expect(append).not.toContain("Use the available orb tools");
  } finally {
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});
