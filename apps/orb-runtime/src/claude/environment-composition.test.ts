import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { environmentPrompt } from "../environment-prompt.ts";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { claudeEnvironmentPrompt } from "./environment-prompt.ts";

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
    skills: [{ name: "owner-notes", content: "---\nname: owner-notes\ndescription: d\n---\n" }],
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

it("boots Claude in a repository-free workspace with managed instructions", async () => {
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
    expect(existsSync(join(workDir, "repo"))).toBe(true);
    expect(existsSync(join(workDir, "repo", ".git"))).toBe(false);
  } finally {
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("installs the owner's skills as Claude user skills, replacing earlier ones, before the session starts", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-owner-skills-"));
  const skills = join(workDir, "claude", "config", "skills");
  mkdirSync(join(skills, "deleted-since"), { recursive: true });
  writeFileSync(join(skills, "deleted-since", "SKILL.md"), "stale");
  let installed: string[] = [];
  const agent = new ClaudeOrbAgent({
    orbId: "orb",
    repositoryUrl: null,
    workDir,
    skillsDir: null,
    broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
    sdkFactory: (_input, value) => {
      installed = readdirSync(skills);
      expect(value.settingSources).toContain("user");
      expect(value.env?.["CLAUDE_CONFIG_DIR"]).toBe(join(workDir, "claude", "config"));
      return err({ message: "No process started." });
    },
  });
  try {
    await agent.boot();
    expect(installed).toEqual(["owner-notes"]);
    expect(readFileSync(join(skills, "owner-notes", "SKILL.md"), "utf8")).toBe(
      "---\nname: owner-notes\ndescription: d\n---\n",
    );
  } finally {
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("blocks boot with owner_skills_unavailable when the owner's skills cannot be loaded", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-owner-skills-failed-"));
  const sdkFactory = vi.fn(() => err({ message: "must not start" }));
  ownerSkills.reply = () => new Error("Cannot load owner skills: HTTP 503");
  const agent = new ClaudeOrbAgent({
    orbId: "orb",
    repositoryUrl: null,
    workDir,
    skillsDir: null,
    broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
    sdkFactory,
  });
  try {
    await agent.boot();
    expect(agent.getHealth()).toMatchObject({
      status: "failed",
      error: {
        code: "owner_skills_unavailable",
        message: "Cannot load owner skills: HTTP 503",
        retryable: true,
      },
    });
    expect(sdkFactory).not.toHaveBeenCalled();
  } finally {
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});
