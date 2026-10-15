import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";

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
vi.mock("../mcp/boot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/boot.ts")>()),
  fetchMcpCatalog: () => okAsync({ revision: 0, servers: [] }),
}));

import { PiOrbAgent } from "./agent.ts";
import { createPersistentSession } from "./settings-persistence.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["new", "header", "removed", "disconnected", "settings-removed-intent"] as const)(
  "Pi boot applies intent before fresh session and preserves native settings (%s)",
  async (mode) => {
    for (const name of ["HOME", "RUSTUP_HOME", "CARGO_HOME", "PATH", "PI_CODING_AGENT_DIR"])
      vi.stubEnv(name, process.env[name]);
    vi.stubEnv("PI_ORB_CONTAINER", "");
    const network = vi.fn(() => Promise.reject(new Error("unexpected network request")));
    vi.stubGlobal("fetch", network);
    const directory = mkdtempSync(join(tmpdir(), "pi-initial-model-"));
    const cwd = join(directory, "repo");
    const sessions = join(directory, "pi-sessions");
    mkdirSync(cwd);
    mkdirSync(sessions);
    const intent = {
      provider: "openai-codex",
      id: mode.includes("removed") ? "removed-initial-intent" : "gpt-6-astra",
    };
    const savedModel = { provider: "openai-codex", id: "gpt-6.1-sol" };
    if (mode === "header" || mode.startsWith("settings")) {
      const saved = createPersistentSession(cwd, sessions)._unsafeUnwrap();
      if (mode.startsWith("settings")) {
        saved.appendModelChange(savedModel.provider, savedModel.id);
        saved.appendThinkingLevelChange("low");
      }
    }
    const create = codingAgent.ModelRuntime.create;
    vi.spyOn(codingAgent.ModelRuntime, "create").mockImplementation(async () => {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai-codex", async () => ({
        type: "oauth",
        access: "fixture-only",
        refresh: "pi-orb-broker",
        expires: Date.now() + 3600000,
      }));
      const runtime = await create({
        credentials,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      if (mode === "disconnected")
        vi.spyOn(runtime, "getAuth").mockRejectedValue(new Error("subscription disconnected"));
      return runtime;
    });
    const agent = new PiOrbAgent({
      orbId: "initial-model",
      repositoryUrl: "https://example.invalid/repo",
      workDir: directory,
      skillsDir: null,
      broker: { controlPlaneUrl: "http://unused.invalid", runtimeToken: "fixture" },
      bootContextReader: () =>
        okAsync({ v: 1, context: null, userTimeZone: null, initialModel: intent }),
    });
    try {
      await agent.boot();
      if (mode === "removed" || mode === "disconnected") {
        expect(agent.getHealth()).toMatchObject({
          status: "failed",
          error: { code: mode === "removed" ? "session_init_failed" : "credential_unavailable" },
        });
        expect(network).not.toHaveBeenCalled();
        return;
      }
      expect(agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(network).not.toHaveBeenCalled();
      const expected = mode.startsWith("settings") ? savedModel : intent;
      expect(agent.snapshot()._unsafeUnwrap().settings?.settings).toEqual({
        model: expected,
        thinkingLevel: mode.startsWith("settings") ? "low" : "high",
      });
      const paths = readdirSync(sessions).filter((path) => path.endsWith(".jsonl"));
      expect(paths).toHaveLength(1);
      const reopened = codingAgent.SessionManager.open(join(sessions, paths[0] ?? ""));
      expect(reopened.buildSessionContext().model).toEqual({
        provider: expected.provider,
        modelId: expected.id,
      });
      expect(
        reopened
          .getEntries()
          .some((entry) => entry.type === "message" && entry.message.role === "assistant"),
      ).toBe(false);
    } finally {
      agent.shutdownHooks();
      await agent.closeExtensions();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
