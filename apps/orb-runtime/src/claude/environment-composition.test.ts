import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { environmentPrompt } from "../environment-prompt.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { claudeEnvironmentPrompt, claudePortExposurePrompt } from "./environment-prompt.ts";

vi.mock("../domain/checkout.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domain/checkout.ts")>();
  return {
    prepareCheckout: (dir: string, url: string | null) =>
      url === null ? actual.prepareCheckout(dir, url) : okAsync("commit"),
  };
});
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
const ownerSkills = vi.hoisted(() => ({
  reply: (): unknown => ({
    skills: [
      {
        name: "owner-notes",
        files: [],
        source: null,
        content: "---\nname: owner-notes\ndescription: d\n---\n",
      },
    ],
  }),
}));
vi.mock("../owner-skills/endpoint.ts", () => ({
  fetchOwnerSkills: () => {
    const reply = ownerSkills.reply();
    return reply instanceof Error
      ? errAsync({ type: "owner_skills_fetch_error", message: reply.message, retryable: true })
      : okAsync(reply);
  },
}));
vi.mock("../project-instructions/endpoint.ts", () => ({
  fetchProjectInstructions: () => okAsync({ content: "PROJECT", revision: 1 }),
}));
const bootContext = vi.hoisted(() => ({
  filesBaseUrl: "https://f-o12345678-1234-1234-1234-123456789abc.piorb.live" as string | undefined,
}));
vi.mock("./boot-context.ts", () => ({
  fetchBootContext: () =>
    okAsync({ context: null, userTimeZone: "America/Los_Angeles", ...bootContext }),
}));
vi.mock("./auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.ts")>()),
  fetchClaudeSubscription: () => okAsync({ token: "test-token", generation: 1 }),
}));

it("appends the shared environment then Claude suffix exactly once before existing context", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-environment-"));
  mkdirSync(join(workDir, "repo"));
  const options: Options[] = [];
  const agent = new ClaudeOrbAgent({
    orbId: "orb",
    repositoryUrl: "https://example.com/repo",
    workDir,
    skillsDir: null,
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
        environmentPrompt(bootContext.filesBaseUrl),
        claudeEnvironmentPrompt,
        "PERSONAL",
        "PROJECT",
        claudePortExposurePrompt,
        "User's time zone: America/Los_Angeles.",
      ].join("\n\n"),
    });
    const append = typeof system === "object" && "append" in system ? (system.append ?? "") : "";
    expect(append.split(environmentPrompt(bootContext.filesBaseUrl))).toHaveLength(2);
    expect(append.split(claudeEnvironmentPrompt)).toHaveLength(2);
    expect(claudePortExposurePrompt).toBe(
      "## Port exposure\n\nTo expose a port on this VM to the user, use the `pi-orb expose` CLI command",
    );
    expect(append).not.toContain("Use the available orb tools");
    expect(append).toContain(`absolute path under ${bootContext.filesBaseUrl},`);
  } finally {
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("boots Claude without live-file guidance when the origin is unconfigured", async () => {
  const filesBaseUrl = bootContext.filesBaseUrl;
  bootContext.filesBaseUrl = undefined;
  const workDir = mkdtempSync(join(tmpdir(), "claude-no-repo-"));
  const options: Options[] = [];
  const agent = new ClaudeOrbAgent({
    orbId: "orb",
    repositoryUrl: null,
    workDir,
    skillsDir: null,
    broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
    sdkFactory: (_input, value) => {
      options.push(value);
      return err({ message: "No process started." });
    },
  });
  try {
    await agent.boot();
    expect(options).toHaveLength(1);
    expect(options[0]?.cwd).toBe(join(workDir, "repo"));
    expect(JSON.stringify(options[0]?.systemPrompt)).toContain("PERSONAL");
    expect(JSON.stringify(options[0]?.systemPrompt)).toContain("PROJECT");
    expect(JSON.stringify(options[0]?.systemPrompt)).not.toContain(
      "When referring to an orb-local file",
    );
    expect(existsSync(join(workDir, "repo"))).toBe(true);
    expect(existsSync(join(workDir, "repo", ".git"))).toBe(false);
  } finally {
    bootContext.filesBaseUrl = filesBaseUrl;
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("installs owner skills as Claude user skills before the session, or blocks boot", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-owner-skills-"));
  const skills = join(workDir, "claude", "config", "skills");
  mkdirSync(join(skills, "deleted-since"), { recursive: true });
  let installed: string[] = [];
  const boot = async () => {
    const agent = new ClaudeOrbAgent({
      orbId: "orb",
      repositoryUrl: null,
      workDir,
      skillsDir: null,
      broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
      sdkFactory: (_input, value) => {
        installed = readdirSync(skills);
        expect(value.settingSources).toContain("user");
        return err({ message: "No process started." });
      },
    });
    await agent.boot();
    agent.shutdownHooks();
    return agent.getHealth();
  };
  try {
    await boot();
    expect(installed).toEqual(["owner-notes"]);
    expect(readFileSync(join(skills, "owner-notes", "SKILL.md"), "utf8")).toContain("owner-notes");
    installed = [];
    ownerSkills.reply = () => new Error("Cannot load owner skills: HTTP 503");
    expect(await boot()).toMatchObject({
      status: "failed",
      error: { code: "owner_skills_unavailable", retryable: true },
    });
    expect(installed).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
