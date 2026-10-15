import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, ok, okAsync } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { ScheduledClaudeQuery } from "../testkit/claude-composed.ts";

const authState = vi.hoisted(() => ({ disconnected: false }));

vi.mock("../domain/checkout.ts", () => ({ prepareCheckout: () => okAsync("commit") }));
vi.mock("../git-identity/apply.ts", () => ({ applyGitIdentity: () => okAsync(undefined) }));
vi.mock("../project-secrets/endpoint.ts", () => ({
  fetchProjectSecretSnapshotAtBoot: () => okAsync({ revision: 0, values: {} }),
}));
vi.mock("../personal-instructions/endpoint.ts", () => ({
  fetchPersonalInstructions: () => okAsync({ revision: 0, content: "" }),
}));
vi.mock("../project-instructions/endpoint.ts", () => ({
  fetchProjectInstructions: () => okAsync({ revision: 0, content: "" }),
}));
vi.mock("../mcp/boot.ts", () => ({
  fetchMcpCatalog: () => okAsync({ revision: 0, servers: [] }),
}));
vi.mock("../pi/boot-context.ts", () => ({
  fetchBootContext: () =>
    okAsync({
      v: 1,
      context: null,
      userTimeZone: null,
      initialModel: { provider: "claude", id: "sonnet" },
    }),
}));
vi.mock("./auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.ts")>()),
  fetchClaudeSubscription: () =>
    authState.disconnected
      ? errAsync({
          code: "claude_auth_required",
          message: "subscription disconnected",
          retryable: false,
        })
      : okAsync({ token: "fixture-only", generation: 1 }),
}));

import { ClaudeOrbAgent, type NativeState } from "./agent.ts";

afterEach(() => {
  authState.disconnected = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["fresh", "retained", "removed", "retained-removed-intent", "disconnected"] as const)(
  "boot applies available effective native model (%s)",
  async (mode) => {
    const retained = mode.startsWith("retained");
    authState.disconnected = mode === "disconnected";
    for (const name of ["HOME", "RUSTUP_HOME", "CARGO_HOME", "PATH"])
      vi.stubEnv(name, process.env[name]);
    vi.stubEnv("PI_ORB_CONTAINER", "");
    const network = vi.fn(() => Promise.reject(new Error("unexpected network request")));
    vi.stubGlobal("fetch", network);
    const directory = mkdtempSync(join(tmpdir(), "claude-initial-model-"));
    const cwd = join(directory, "repo");
    mkdirSync(cwd);
    mkdirSync(join(directory, "claude"));
    const path = join(directory, "claude", "session.json");
    const sessionId = "a994788d-2476-42d4-950c-ccbf33050cdd";
    if (retained)
      writeFileSync(
        path,
        JSON.stringify({
          id: sessionId,
          timestamp: "2026-10-14T00:00:00Z",
          cwd,
          deliveries: {},
          model: "opus",
          effort: "high",
        }),
      );
    const selected: string[] = [];
    const queries: ScheduledClaudeQuery[] = [];
    const agent = new ClaudeOrbAgent({
      orbId: "model-intent",
      repositoryUrl: "https://example.invalid/repo",
      workDir: directory,
      skillsDir: null,
      broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "fixture" },
      sdkFactory: (input, options) => {
        const query = new ScheduledClaudeQuery(input, options, true);
        query.supportedModels = async () =>
          (mode.includes("removed") ? ["opus"] : ["opus", "sonnet"]).map((value) => ({
            value,
            displayName: value,
            description: "",
            supportedEffortLevels: ["high" as const],
          }));
        query.setModel = async (model?: string) => {
          selected.push(model ?? "");
        };
        queries.push(query);
        return ok({
          query,
          exited: query.processExit.promise,
          stdoutEnded: query.stdoutEnded,
          requestShutdown: () => query.requestShutdown(),
        });
      },
    });
    try {
      await agent.boot();
      if (mode === "removed" || mode === "disconnected") {
        expect(agent.getHealth()).toMatchObject({ status: "failed" });
        expect(selected).toEqual([]);
        expect(network).not.toHaveBeenCalled();
        return;
      }
      expect(agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(network).not.toHaveBeenCalled();
      const expected = retained ? "opus" : "sonnet";
      expect(selected).toEqual([expected]);
      expect(queries.map((query) => query.options.model)).toEqual([expected]);
      const saved = JSON.parse(readFileSync(path, "utf8")) as NativeState;
      expect(saved.model).toBe(expected);
      if (retained) expect(saved.id).toBe(sessionId);
      expect(agent.snapshot()._unsafeUnwrap().settings?.settings.model).toEqual({
        provider: "claude",
        id: expected,
      });
      expect(queries.every((query) => query.closeRequested)).toBe(true);
    } finally {
      agent.shutdownHooks();
      for (const query of queries) {
        query.exit();
        query.endOutput();
        query.close();
      }
      await agent.closeExtensions();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
