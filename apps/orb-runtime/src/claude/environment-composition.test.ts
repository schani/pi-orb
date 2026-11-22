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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { environmentPrompt } from "../environment-prompt.ts";
import { ScheduledClaudeQuery } from "../testkit/claude-composed.ts";
import { ClaudeOrbAgent, type ClaudeQuery } from "./agent.ts";
import { claudeEnvironmentPrompt, claudePortExposurePrompt } from "./environment-prompt.ts";
import { ClaudeHistory } from "./history.ts";

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

const pendingModel = { changeId: "queued-choice", model: { provider: "claude", id: "sonnet" } };
const bootPath = "http://unused.invalid/runtime/v1/orb/boot-context";
const ackPath = "http://unused.invalid/runtime/v1/orb/pending-model/ack";
const wakeContext = {
  messageId: "wake",
  messageIds: ["wake"],
  content: [{ type: "text", text: "Scheduled wake." }],
  system: { kind: "sleep_wake", sleepUntil: "2026-10-04T01:00:00Z" },
};

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function retainedRuntime(interrupted = false) {
  const workDir = mkdtempSync(join(tmpdir(), "claude-queued-model-"));
  const cwd = join(workDir, "repo");
  const journal = join(workDir, "claude", "session.json");
  mkdirSync(join(workDir, "claude"), { recursive: true });
  const sessionId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(
    journal,
    JSON.stringify({
      id: sessionId,
      cwd,
      timestamp: "2026-10-04T00:00:00Z",
      deliveries: {},
      model: "fable",
      effort: "max",
    }),
  );
  if (interrupted) {
    const projects = join(workDir, "claude", "config", "projects", "test-project");
    mkdirSync(projects, { recursive: true });
    new ClaudeHistory(join(workDir, "claude"), sessionId, "2026-10-04T00:00:00Z")
      .correlate("pending-turn", { messageIds: ["human-inbox"], operationId: "human-op" })
      ._unsafeUnwrap();
    writeFileSync(
      join(projects, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "pending-turn", sessionId, message: { role: "user", content: "Unanswered work" } })}\n`,
    );
  }
  const launches: ScheduledClaudeQuery[] = [];
  const modelsApplied: (string | undefined)[] = [];
  const flagsApplied: unknown[] = [];
  const agents: ClaudeOrbAgent[] = [];
  return {
    launches,
    modelsApplied,
    flagsApplied,
    journal: () => JSON.parse(readFileSync(journal, "utf8")),
    create() {
      const agent = new ClaudeOrbAgent({
        orbId: "orb",
        repositoryUrl: null,
        workDir,
        skillsDir: null,
        broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" },
        sdkFactory: (input, options) => {
          const sdk = new ScheduledClaudeQuery(input, options, true);
          launches.push(sdk);
          const query: ClaudeQuery = {
            [Symbol.asyncIterator]: () => sdk[Symbol.asyncIterator](),
            close: () => sdk.close(),
            interrupt: sdk.interrupt,
            accountInfo: sdk.accountInfo,
            supportedModels: async () => [
              {
                value: "opus",
                displayName: "Opus",
                description: "",
                supportedEffortLevels: ["high"],
              },
              {
                value: "sonnet",
                displayName: "Sonnet",
                description: "",
                supportedEffortLevels: ["low"],
              },
            ],
            setModel: async (model) => {
              modelsApplied.push(model);
            },
            applyFlagSettings: async (flags) => {
              flagsApplied.push(flags);
            },
          };
          return ok({
            query,
            exited: sdk.processExit.promise,
            stdoutEnded: sdk.stdoutEnded,
            requestShutdown: () => sdk.requestShutdown(),
          });
        },
      });
      agents.push(agent);
      return agent;
    },
    async dispose() {
      for (const agent of agents) agent.shutdownHooks();
      for (const sdk of launches) sdk.requestShutdown();
      await Promise.all(agents.map((agent) => agent.waitForStream()));
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

it.each(["first input", "boot continuation", "sleep wake"])(
  "persists and acknowledges the queued model before %s",
  async (turn) => {
    const f = retainedRuntime(turn === "boot continuation");
    const ackRequested = latch();
    const allowAck = latch();
    const agent = f.create();
    const fetch = vi.fn(async (url: string) => {
      if (url === bootPath)
        return Response.json({
          ...bootContext,
          pendingModel,
          context: turn === "sleep wake" ? wakeContext : null,
        });
      expect(url).toBe(ackPath);
      ackRequested.release();
      await allowAck.promise;
      return Response.json({ v: 1 });
    });
    vi.stubGlobal("fetch", fetch);
    const booting = agent.boot();
    try {
      // If boot fails before calling ack, make that a test failure rather than a hung gate.
      expect(
        await Promise.race([ackRequested.promise.then(() => "ack"), booting.then(() => "boot")]),
      ).toBe("ack");
      expect(f.launches.map((sdk) => sdk.options.model)).toEqual(["sonnet"]);
      expect(f.modelsApplied).toEqual(["sonnet"]);
      expect(f.flagsApplied).toEqual([{ effortLevel: "low" }]);
      expect(f.journal()).toMatchObject({ model: "sonnet", effort: "low" });
      expect(agent.getHealth().status).toBe("initializing");
      expect(
        (await agent.submitMessage([{ type: "text", text: "too early" }], "blocked")).isErr(),
      ).toBe(true);
      expect(fetch).toHaveBeenLastCalledWith(
        ackPath,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer unused" }),
          body: JSON.stringify({ v: 1, changeId: pendingModel.changeId }),
        }),
      );
      allowAck.release();
      await booting;
      expect(agent.getHealth().status).toBe("ready");
      if (turn === "first input")
        (
          await agent.submitMessage([{ type: "text", text: "first message" }], "first")
        )._unsafeUnwrap();
      expect(f.launches.map((sdk) => sdk.options.model)).toEqual(["sonnet", "sonnet"]);
      const input = await f.launches[1]?.input.next();
      expect(JSON.stringify(input?.value)).toContain(
        turn === "first input"
          ? "first message"
          : turn === "sleep wake"
            ? "Scheduled wake."
            : "The previous turn was interrupted",
      );
    } finally {
      allowAck.release();
      await booting;
      await f.dispose();
    }
  },
);

it.each(["unavailable", "stale authority", "lost response after commit"])(
  "fails closed on %s and uses a fresh boot read to recover the model",
  async (failure) => {
    const f = retainedRuntime();
    let ackCount = 0;
    let pending = true;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === bootPath)
        return Response.json({
          ...bootContext,
          ...(pending ? { pendingModel } : {}),
          context: wakeContext,
        });
      expect(url).toBe(ackPath);
      if (++ackCount === 1) {
        if (failure === "lost response after commit") {
          pending = false;
          throw new Error("response lost");
        }
        return Response.json(
          { error: { message: failure, retryable: failure === "unavailable" } },
          { status: failure === "unavailable" ? 503 : 409 },
        );
      }
      pending = false;
      return Response.json({ v: 1 });
    });
    try {
      const first = f.create();
      await first.boot();
      expect(first.getHealth()).toMatchObject({
        status: "failed",
        error: {
          code: "claude_pending_model_ack_failed",
          message: expect.stringContaining(
            failure === "lost response after commit" ? "request failed" : failure,
          ),
        },
      });
      expect(first.gateView().acceptingWork).toBe(false);
      expect(
        (
          await first.submitMessage([{ type: "text", text: "blocked after failed ack" }], "blocked")
        ).isErr(),
      ).toBe(true);
      expect(f.launches).toHaveLength(1);
      expect(f.journal()).toMatchObject({ model: "sonnet", effort: "low" });

      const replay = f.create();
      await replay.boot();
      expect(ackCount).toBe(failure === "lost response after commit" ? 1 : 2);
      expect(replay.getHealth().status).toBe("ready");
      expect(f.launches.map((sdk) => sdk.options.model)).toEqual(["sonnet", "sonnet", "sonnet"]);
      expect(JSON.stringify((await f.launches[2]?.input.next())?.value)).toContain(
        "Scheduled wake.",
      );
    } finally {
      await f.dispose();
    }
  },
);

it.each([
  {
    model: { provider: "claude", id: "not-advertised" },
    error: "Selected Claude model is unavailable",
  },
  {
    model: { provider: "openai-codex", id: "not-claude" },
    error: "does not belong to the Claude harness",
  },
])("refuses $model instead of acknowledging or falling back", async ({ model, error }) => {
  const f = retainedRuntime();
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe(bootPath);
    return Response.json({
      ...bootContext,
      pendingModel: { ...pendingModel, model },
      context: wakeContext,
    });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const agent = f.create();
    await agent.boot();
    expect(agent.getHealth()).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining(error) },
    });
    expect(agent.gateView().acceptingWork).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.modelsApplied).toEqual([]);
    expect(f.journal()).toMatchObject({ model: "fable", effort: "max" });
  } finally {
    await f.dispose();
  }
});
