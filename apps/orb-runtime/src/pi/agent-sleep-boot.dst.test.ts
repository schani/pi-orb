import type { ExecFileException } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { OrbBootContext } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { runDst } from "../testkit/sim.ts";

const controls = vi.hoisted(() => ({
  manager: null as null | {
    appendCustomMessageEntry: (
      customType: string,
      content: unknown,
      display: boolean,
      details?: unknown,
    ) => string;
  },
  session: null as null | DeferredPiSession,
  sessionCreationStarted: false,
  awaitSessionCreation: undefined as undefined | (() => Promise<void>),
  executedFiles: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (
      file: string,
      _args: string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      controls.executedFiles.push(file);
      callback(null, "commit\n", "");
      return {} as ReturnType<typeof original.execFile>;
    },
  };
});

vi.mock("../project-secrets/endpoint.ts", () => ({
  fetchProjectSecretSnapshotAtBoot: () => okAsync({ revision: 1, values: {} }),
}));
vi.mock("../personal-instructions/endpoint.ts", () => ({
  fetchPersonalInstructions: () => okAsync({ revision: 1, content: "" }),
}));
vi.mock("../project-instructions/endpoint.ts", () => ({
  fetchProjectInstructions: () => okAsync({ revision: 1, content: "" }),
}));
vi.mock("../mcp/boot.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mcp/boot.ts")>();
  return { ...original, fetchMcpCatalog: () => okAsync({ revision: 1, servers: [] }) };
});
vi.mock("./resource-loader.ts", () => ({ createOrbResourceLoader: () => okAsync({}) }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const model = {
    id: "gpt-6-astra",
    provider: "openai-codex",
    input: ["text", "image"],
    reasoning: true,
  };
  return {
    ...original,
    ModelRuntime: {
      create: async () => ({
        registerProvider: () => undefined,
        getAuth: async () => ({ accessToken: "test" }),
        refresh: async () => undefined,
        getModels: () => [model],
        checkAuth: async () => true,
      }),
    },
    createAgentSession: async ({ sessionManager }: { sessionManager: typeof controls.manager }) => {
      controls.sessionCreationStarted = true;
      await controls.awaitSessionCreation?.();
      controls.manager = sessionManager;
      const session = new DeferredPiSession();
      controls.session = session;
      return { session };
    },
  };
});

import { PiOrbAgent } from "./agent.ts";

class DeferredPiSession {
  readonly model = { id: "gpt-6-astra", provider: "openai-codex" };
  readonly thinkingLevel = "medium";
  readonly extensionRunner = { emit: async () => undefined };
  private active = false;
  private readonly listeners: ((event: AgentSessionEvent) => void)[] = [];
  readonly markers: { customType: string; details?: unknown }[] = [];

  get isIdle(): boolean {
    return !this.active;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }

  bindExtensions(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}
  setThinkingLevel(): void {}
  setModel(): Promise<void> {
    return Promise.resolve();
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
  abortBash(): void {}
  executeBash(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  sendUserMessage(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }

  sendCustomMessage(
    marker: { customType: string; content: unknown; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean },
  ): Promise<void> {
    this.markers.push(marker);
    controls.manager?.appendCustomMessageEntry(
      marker.customType,
      marker.content,
      marker.display,
      marker.details,
    );
    if (options?.triggerTurn) this.active = true;
    return Promise.resolve();
  }

  announceAgentStart(): void {
    for (const listener of this.listeners) listener({ type: "agent_start" } as AgentSessionEvent);
  }
}

const roots: string[] = [];
const originalEnvironment = {
  HOME: process.env["HOME"],
  RUSTUP_HOME: process.env["RUSTUP_HOME"],
  CARGO_HOME: process.env["CARGO_HOME"],
  PATH: process.env["PATH"],
  PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"],
};
afterEach(() => {
  controls.manager = null;
  controls.session = null;
  controls.sessionCreationStarted = false;
  controls.awaitSessionCreation = undefined;
  controls.executedFiles.length = 0;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const wake: OrbBootContext = {
  messageId: "sleep-1",
  messageIds: ["sleep-1"],
  content: [{ type: "text", text: "Sleep ended at its scheduled deadline." }],
  system: { kind: "sleep_wake", sleepUntil: "2026-09-18T04:05:06.000Z" },
};

it("actual boot preserves Rust state without spawning an installer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-sleep-boot-error-"));
  roots.push(root);
  mkdirSync(join(root, "repo"), { recursive: true });
  const installedToolchain = join(root, "home", ".rustup", "toolchains", "custom");
  const installedToolchainMarker = join(installedToolchain, "marker");
  mkdirSync(installedToolchain, { recursive: true });
  writeFileSync(installedToolchainMarker, "preserved");
  const agent = new PiOrbAgent({
    orbId: "orb",
    repositoryUrl: "https://example.com/repo.git",
    workDir: root,
    skillsDir: null,
    broker: { controlPlaneUrl: "http://control-plane.test", runtimeToken: "secret" },
    bootContextReader: () =>
      errAsync({
        type: "boot_context_error",
        message: "boot context is unavailable: injected read failure",
        retryable: true,
      }),
  });
  await agent.boot();
  expect(agent.getHealth()).toMatchObject({
    status: "failed",
    error: {
      code: "boot_context_unavailable",
      message: "boot context is unavailable: injected read failure",
      retryable: true,
    },
  });
  expect(controls.session).toBeNull();
  expect(controls.executedFiles).not.toContain("rustup");
  expect(process.env.RUSTUP_HOME).toBe(join(root, "home", ".rustup"));
  expect(process.env.CARGO_HOME).toBe(join(root, "home", ".cargo"));
  expect(existsSync(installedToolchainMarker)).toBe(true);
  expect(
    (await agent.deliverInboxMessage("sleep-1", ["sleep-1"], wake.content, wake.system)).isErr(),
  ).toBe(true);
});

it("actual boot holds readiness through context and turn-start barriers, then deduplicates persisted wake", async () => {
  await runDst({ name: "agent-sleep-boot-barriers", iterations: 30 }, async (sim) => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-sleep-boot-"));
    roots.push(root);
    mkdirSync(join(root, "repo"), { recursive: true });
    const context = deferred<{ v: 1; context: OrbBootContext | null }>();
    const sessionCreation = deferred<void>();
    controls.awaitSessionCreation = () => sessionCreation.promise;
    const agent = new PiOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo.git",
      workDir: root,
      skillsDir: null,
      broker: { controlPlaneUrl: "http://control-plane.test", runtimeToken: "secret" },
      executionId: "host-2",
      bootContextReader: () => ResultAsync.fromSafePromise(context.promise),
    });
    let bootDone = false;
    const run = await sim.runTasks([
      {
        name: "boot",
        f: async (_task: SimulationTask) => {
          await agent.boot();
          bootDone = true;
        },
      },
      {
        name: "before-context",
        f: async (task: SimulationTask) => {
          await task.checkpoint("boot context blocked");
          expect(agent.getHealth().status).toBe("initializing");
          expect(
            (
              await agent.deliverInboxMessage("sleep-1", ["sleep-1"], wake.content, wake.system)
            ).isErr(),
          ).toBe(true);
          context.resolve({ v: 1, context: wake });
          while (!controls.sessionCreationStarted)
            await task.checkpoint("wait for context-dependent session creation");
          expect(agent.getHealth().status).toBe("initializing");
          expect(
            (
              await agent.deliverInboxMessage("sleep-1", ["sleep-1"], wake.content, wake.system)
            ).isErr(),
          ).toBe(true);
          sessionCreation.resolve();
          while (!bootDone) await task.checkpoint("wait for session attachment");
        },
      },
      {
        name: "delivery",
        f: async (task: SimulationTask) => {
          while (!bootDone) await task.checkpoint("delivery waits for readiness");
          const health = agent.getHealth();
          if (health.status === "failed") throw new Error(JSON.stringify(health.error));
          expect(health).toMatchObject({ status: "ready", activity: "busy" });
          expect(controls.session?.markers).toHaveLength(1);
          expect(controls.session?.markers[0]).toMatchObject({
            customType: "pi-orb.sleep-wake",
            details: { messageIds: ["sleep-1"] },
          });
          let settled = false;
          const delivery = agent
            .deliverInboxMessage("sleep-1", ["sleep-1"], wake.content, wake.system)
            .map((value) => {
              settled = true;
              return value;
            })
            .mapErr((error) => {
              settled = true;
              return error;
            });
          await task.checkpoint("delivery blocked before agent_start");
          expect(settled).toBe(false);
          controls.session?.announceAgentStart();
          const result = await delivery;
          expect(result._unsafeUnwrap()).toMatchObject({
            status: "persisted",
            duplicate: true,
          });
          expect(controls.session?.markers).toHaveLength(1);
        },
      },
    ]);
    if (run.isErr()) throw run.error;
  });
});
