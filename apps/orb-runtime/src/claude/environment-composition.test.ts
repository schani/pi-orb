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
import { ORB_BOOT_CONTEXT_PATH, ORB_PENDING_MODEL_ACK_PATH } from "@pi-orb/protocol";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { environmentPrompt } from "../environment-prompt.ts";
import { ScheduledClaudeQuery } from "../testkit/claude-composed.ts";
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
const ownerSkills = vi.hoisted(() => {
  const snapshot = (): unknown => ({
    skills: [
      {
        name: "owner-notes",
        files: [],
        source: null,
        content: "---\nname: owner-notes\ndescription: d\n---\n",
      },
    ],
  });
  return { snapshot, reply: snapshot };
});
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
const bootContext = { v: 1, context: null, userTimeZone: "America/Los_Angeles" };

beforeEach(() => {
  ownerSkills.reply = ownerSkills.snapshot;
  vi.stubGlobal("fetch", async () => Response.json(bootContext));
});
afterEach(() => vi.unstubAllGlobals());
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
        environmentPrompt("pi-orb link"),
        claudeEnvironmentPrompt,
        "PERSONAL",
        "PROJECT",
        claudePortExposurePrompt,
        "User's time zone: America/Los_Angeles.",
      ].join("\n\n"),
    });
    const append = typeof system === "object" && "append" in system ? (system.append ?? "") : "";
    expect(append.split(environmentPrompt("pi-orb link"))).toHaveLength(2);
    expect(append.split(claudeEnvironmentPrompt)).toHaveLength(2);
    expect(claudePortExposurePrompt).toBe(
      "## Port exposure\n\nTo expose a port on this VM to the user, use the `pi-orb expose` CLI command",
    );
    expect(append).not.toContain("Use the available orb tools");
    const rule =
      "When referring to an orb-local file in prose, use a Markdown link with `orb:<repository-relative-path>` (for example, `orb:README.md`) or `orb:/absolute/path`. Percent-encode each path segment. Keep filesystem paths unchanged inside code and commands. Resolve absolute paths with `pwd`/`realpath`; do not assume a workspace root.";
    expect(append.split(rule)).toHaveLength(2);
    expect(append).not.toContain("https://files.");
    expect(append).not.toContain("/files/");
    expect(append).not.toContain("12345678-1234-1234-1234-123456789abc");
    expect(append).not.toContain(workDir);
  } finally {
    agent.shutdownHooks();
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("boots Claude with compact file guidance without a repository checkout", async () => {
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
    expect(JSON.stringify(options[0]?.systemPrompt)).toContain("orb:README.md");
    expect(JSON.stringify(options[0]?.systemPrompt)).toContain("orb:/absolute/path");
    expect(JSON.stringify(options[0]?.systemPrompt)).not.toContain(workDir);
    expect(existsSync(join(workDir, "repo"))).toBe(true);
    expect(existsSync(join(workDir, "repo", ".git"))).toBe(false);
  } finally {
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

it.each(["denied", "lost"] as const)(
  "starts no Claude turn when ack is %s, then replays safely",
  async (failure) => {
    const workDir = mkdtempSync(join(tmpdir(), "claude-pending-model-"));
    const journal = join(workDir, "claude", "session.json");
    const pendingModel = { changeId: "choice", model: { provider: "claude", id: "sonnet" } };
    mkdirSync(join(workDir, "claude"));
    writeFileSync(
      journal,
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        cwd: join(workDir, "repo"),
        timestamp: "2026-10-04T00:00:00Z",
        deliveries: {},
        model: "opus",
        effort: "max",
      }),
    );
    let pending = true;
    let acks = 0;
    const turns: ScheduledClaudeQuery[] = [];
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      if (url.endsWith(ORB_BOOT_CONTEXT_PATH))
        return Response.json({
          ...bootContext,
          ...(pending ? { pendingModel } : {}),
          context: {
            messageId: "wake",
            messageIds: ["wake"],
            content: [{ type: "text", text: "Scheduled wake." }],
            system: { kind: "sleep_wake", sleepUntil: "2026-10-04T01:00:00Z" },
          },
        });
      expect(url).toBe(`http://unused.invalid${ORB_PENDING_MODEL_ACK_PATH}`);
      expect(options.body).toBe(JSON.stringify({ v: 1, changeId: pendingModel.changeId }));
      expect(JSON.parse(readFileSync(journal, "utf8"))).toMatchObject({
        model: "sonnet",
        effort: "high",
      });
      expect(turns).toHaveLength(0);
      if (++acks === 1 && failure === "denied")
        return Response.json(
          { error: { message: "stale authority", retryable: false } },
          { status: 409 },
        );
      pending = false;
      if (acks === 1) return Promise.reject(new TypeError("ack response lost"));
      return Response.json({ v: 1 });
    });
    const agents: ClaudeOrbAgent[] = [];
    try {
      for (const replay of [false, true]) {
        let metadata = true;
        const agent = new ClaudeOrbAgent({
          orbId: "orb",
          repositoryUrl: null,
          workDir,
          skillsDir: null,
          broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
          sdkFactory: (input, options) => {
            const query = new ScheduledClaudeQuery(input, options, true);
            query.supportedModels = async () => [
              {
                value: "sonnet",
                displayName: "Sonnet",
                description: "",
                supportedEffortLevels: ["high"],
              },
            ];
            if (!metadata) turns.push(query);
            metadata = false;
            return ok({
              query,
              exited: query.processExit.promise,
              stdoutEnded: query.stdoutEnded,
              requestShutdown: () => query.requestShutdown(),
            });
          },
        });
        agents.push(agent);
        await agent.boot();
        if (!replay) {
          expect(agent.getHealth()).toMatchObject({
            status: "failed",
            error: { code: "claude_pending_model_ack_failed" },
          });
          expect(
            (await agent.submitMessage([{ type: "text", text: "blocked" }], "blocked")).isErr(),
          ).toBe(true);
          expect(turns).toHaveLength(0);
        }
      }
      expect(acks).toBe(failure === "denied" ? 2 : 1);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.options.model).toBe("sonnet");
      expect(JSON.stringify((await turns[0]?.input.next())?.value)).toContain("Scheduled wake.");
    } finally {
      for (const agent of agents) agent.shutdownHooks();
      for (const turn of turns) turn.requestShutdown();
      await Promise.all(agents.map((agent) => agent.waitForStream()));
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
