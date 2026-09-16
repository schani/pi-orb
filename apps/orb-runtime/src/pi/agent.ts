import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { MockOpenAiConfig } from "@pi-orb/mock-openai";
import {
  type AgentSettings,
  type DeliverOrbMessageResponse,
  type HistoryRecord,
  type MessageInputBlock,
  ORB_NAME_MESSAGE_MAX_BYTES,
  ORB_NAME_README_MAX_BYTES,
  type RuntimeEvent,
  type RuntimeHealth,
  type RuntimeHooks,
  type RuntimeTurnResume,
  type ServerFrame,
  type SettingsAction,
  validateRepositoryUrl,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { type BrokerEnv, HttpBrokerEndpoint } from "../broker/endpoint.ts";
import { brokerProviderConfig } from "../broker/provider.ts";
import { AgentSettingsController } from "../domain/agent-settings.ts";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { gateUnflushedSnapshot } from "../domain/history.ts";
import { configurePersistentHome } from "../domain/home.ts";
import type { AgentGateView } from "../domain/requests.ts";
import { ensurePersistentRustToolchain } from "../domain/rust.ts";
import { type SubagentError, type SubagentRun, SubagentWork } from "../domain/subagent-work.ts";
import {
  buildTurnSummaryInput,
  type TurnSummarizer,
  TurnSummaryCoordinator,
} from "../domain/turn-summary.ts";
import type { HarnessSnapshot, LiveOperationView } from "../domain/types.ts";
import type { HookEnvSource } from "../hooks/env-file.ts";
import type { HookSpawner } from "../hooks/ports.ts";
import { BootHookRunner } from "../hooks/runner.ts";
import { NodeHookSpawner } from "../hooks/spawner.ts";
import { fetchMcpCatalog, resolveMcpHeaders } from "../mcp/boot.ts";
import { HttpMcpTokenEndpoint, McpCredentialResolver } from "../mcp/oauth.ts";
import { McpConnection } from "../mcp/service.ts";
import { McpTools } from "../mcp/tools.ts";
import { HttpMcpTransport } from "../mcp/transport.ts";
import { triggerOrbName } from "../naming/client.ts";
import { readRootReadme } from "../naming/context.ts";
import { fetchPersonalInstructions } from "../personal-instructions/endpoint.ts";
import { fetchProjectInstructions } from "../project-instructions/endpoint.ts";
import { fetchProjectSecretSnapshotAtBoot } from "../project-secrets/endpoint.ts";
import { BOOT_BASELINE_TYPE, planBootNotification } from "./boot-notification.ts";
import { settleBootPrerequisites } from "./boot-prerequisites.ts";
import { readExecutionIdentity } from "./execution-identity.ts";
import { FileIdleStopFence, type IdleStopFence } from "./idle-stop-fence.ts";
import {
  instructionsAdoption,
  PERSONAL_INSTRUCTIONS_ADOPTION,
  PROJECT_INSTRUCTIONS_ADOPTION,
} from "./instructions-adoption.ts";
import { LiveHistoryPublisher } from "./live-history.ts";
import { LunaTurnSummarizer } from "./luna-summarizer.ts";
import { mapPiEntry, mapPiSessionHeader } from "./mapping.ts";
import { createOrbResourceLoader } from "./resource-loader.ts";
import { restoreSessionSettings, settingsFallbackMessage } from "./restore-settings.ts";
import { reportRustToolchainEdge } from "./rust-toolchain-reporter.ts";
import { sessionFlushed } from "./session-flush.ts";
import { createPersistentSession, syncSessionFile } from "./settings-persistence.ts";
import { interruptedSubagents } from "./subagent-recovery.ts";

export interface PiOrbAgentOptions {
  readonly orbId: string;
  readonly repositoryUrl: string;
  /** Persistent orb filesystem root (the Docker volume). */
  readonly workDir: string;
  /** Host-provider supplied bundled-skills install directory. */
  readonly skillsDir: string | null;
  /** Control-plane broker access (docs/credentials.md); the only credential path. */
  readonly broker: BrokerEnv | null;
  /** E2E mode: route inference to the fake OpenAI service. */
  readonly mockOpenAi?: MockOpenAiConfig | null;
  /**
   * Tailnet FQDN the orb's ports are reachable at (docs/ports.md), or null
   * when tier-1 port exposure is off. Only the agent's system prompt uses it.
   */
  readonly previewHost?: string | null;
  /** Compute incarnation this boot belongs to; keys the setup hook's stamp. */
  readonly incarnation?: string;
  /** Test seam; production reads the host/container execution identity at boot. */
  readonly executionId?: string | null;
  readonly idleStopFence?: IdleStopFence;
  /** Test seam; production spawns the repository's boot hooks with `NodeHookSpawner`. */
  readonly hookSpawner?: HookSpawner;
  /** Test seam; production creates the Luna adapter from the orb's existing ModelRuntime. */
  readonly turnSummarizer?: TurnSummarizer;
  /** E2E composition seam: expose one selected incarnation as terminally failed. */
  readonly testLaunchFailure?: boolean;
}

export interface SnapshotError {
  readonly type: "snapshot_error";
  readonly message: string;
}

/**
 * The Pi session surface the adapter drives. Narrowing the SDK object to the
 * calls actually made is what lets deterministic tests stand in for Pi and
 * schedule its event delivery (docs/testing.md, docs/pi-adapter.md);
 * production always passes a real `AgentSession`.
 */
export type PiSession = Pick<
  AgentSession,
  | "subscribe"
  | "sendUserMessage"
  | "sendCustomMessage"
  | "executeBash"
  | "abort"
  | "abortBash"
  | "isIdle"
>;

/** The `SessionManager` surface the adapter reads, narrowed for the same reason. */
export type PiSessionManager = Pick<
  SessionManager,
  | "getEntries"
  | "getLeafId"
  | "getHeader"
  | "getSessionId"
  | "getSessionFile"
  | "buildContextEntries"
  | "appendCustomEntry"
  | "appendCustomMessageEntry"
>;

type FrameListener = (frame: ServerFrame) => void;

interface LiveBlock {
  blockType: "text" | "reasoning" | "shell";
  revision: number;
  text: string;
}

interface LiveTool {
  name: string;
  revision: number;
  state: "running" | "completed" | "failed";
  message?: string;
}

const LIVE_SHELL_OUTPUT_LIMIT = 50 * 1024;
const LIVE_SHELL_TRUNCATION_MARKER = "[earlier live output truncated]\n";

const execGit = (args: string[], cwd: string): ResultAsync<string, { message: string }> =>
  ResultAsync.fromPromise(
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 10 * 60_000,
          env: {
            ...process.env,
            GIT_ALLOW_PROTOCOL: "https",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        (error, stdout, stderr) => {
          if (error !== null) reject(new Error(stderr || error.message));
          else resolve(stdout.trim());
        },
      );
    }),
    (error) => ({ message: error instanceof Error ? error.message : String(error) }),
  );

/**
 * The Pi SDK integration: owns the session, translates Pi events to protocol
 * frames, and exposes synchronous snapshots for pulls and the hello sync
 * batch. One instance per runtime process.
 */
export class PiOrbAgent {
  readonly runtimeInstanceId = randomUUID();
  private readonly options: PiOrbAgentOptions;
  private health: RuntimeHealth;
  private sessionManager: PiSessionManager | null = null;
  private settingsController: AgentSettingsController | null = null;
  private observeSettings: (() => void) | null = null;
  private session: PiSession | null = null;
  private shutdownExtensions: (() => Promise<void>) | null = null;
  private closingExtensions: Promise<void> | null = null;
  private liveHistory: LiveHistoryPublisher | null = null;
  private checkoutCommit = "";
  private executionId: string | null = null;
  private supervisorId: string | null = null;
  private idleStopPrepared = false;
  private readonly idleStopFence: IdleStopFence;
  private activity: "idle" | "busy" = "idle";
  /** This boot's interrupted-turn decision, when notable (docs/lifecycle.md). */
  private turnResume: RuntimeTurnResume | null = null;
  private operationId: string | null = null;
  private operationKind: "agent" | "shell" | null = null;
  private readonly subagentWork = new SubagentWork();
  private operationOutcome: "completed" | "aborted" | "failed" = "completed";
  private operationError: string | undefined;
  private abortSubagents: (() => Result<void, SubagentError>) | null = null;
  /**
   * Set while an accepted agent submission is waiting for Pi to begin its
   * turn; resolves at `agent_start` or when the submission fails. Pi only
   * marks itself streaming when it begins the turn, which is later than the
   * runtime's own acceptance — handing Pi a second submission inside that
   * window makes it start a competing turn and refuse the loser ("Agent is
   * already processing"), so a delivery waits the window out before reading
   * activity (docs/pi-adapter.md).
   */
  private turnStart: { readonly promise: Promise<void>; readonly resolve: () => void } | null =
    null;
  private summaryStartIndex: number | null = null;
  private summaryCoordinator: TurnSummaryCoordinator | null = null;
  private shellCommand = "";
  private shellOutput = "";
  private shellOutputTruncated = false;
  private readonly liveBlocks = new Map<string, LiveBlock>();
  private outputMessageSequence = 0;
  private readonly messageBlocks = new WeakMap<object, string[]>();
  private readonly liveTools = new Map<string, LiveTool>();
  private readonly listeners = new Set<FrameListener>();
  private readonly pendingInboxMessages = new Map<
    string,
    { delivery: "turn" | "steer"; operationId: string }
  >();
  private autoNameTriggered = false;
  /** Created once the checkout exists; null before, and when hooks never ran. */
  private hooks: BootHookRunner | null = null;

  constructor(options: PiOrbAgentOptions) {
    this.options = options;
    this.idleStopFence = options.idleStopFence ?? new FileIdleStopFence(options.workDir);
    this.health = this.initializing("booting");
  }

  private initializing(
    phase:
      | "booting"
      | "cloning"
      | "setup_running"
      | "checking_project_secrets"
      | "loading_session"
      | "checking_auth",
  ): RuntimeHealth {
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "initializing",
      phase,
    };
  }

  /**
   * The env file, for a terminal opened later. Handed out before the runner
   * exists — the terminal manager is installed while the orb is still cloning —
   * so it resolves the runner per call and reports nothing until there is one.
   */
  hookEnvSource(): HookEnvSource {
    return { hookEnv: () => this.hooks?.hookEnv() ?? null };
  }

  /** Read at report time, not at transition time: a backgrounded resume finishes late. */
  private hookReport(): { hooks?: RuntimeHooks } {
    const report = this.hooks?.report();
    if (report === undefined || (report.setup === undefined && report.resume === undefined)) {
      return {};
    }
    return { hooks: report };
  }

  private failed(code: string, message: string, retryable: boolean): RuntimeHealth {
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "failed",
      error: { code, message, retryable },
    };
  }

  getHealth(): RuntimeHealth {
    if (this.health.status === "failed") return this.health;
    if (this.health.status !== "ready") return { ...this.health, ...this.hookReport() };
    return {
      ...this.health,
      activity: this.activity,
      ...(this.operationId !== null ? { operationId: this.operationId } : {}),
      ...(this.turnResume !== null ? { turnResume: this.turnResume } : {}),
      ...this.hookReport(),
    };
  }

  /** Terminates a resume hook that outlived its blocking window. */
  shutdownHooks(): void {
    this.hooks?.shutdown();
  }

  closeExtensions(): Promise<void> {
    this.closingExtensions ??= this.shutdownExtensions?.() ?? Promise.resolve();
    return this.closingExtensions;
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  private broadcastEvent(event: RuntimeEvent): void {
    this.broadcast({ v: 1, type: "runtime.event", at: new Date().toISOString(), event });
  }

  // -- boot -----------------------------------------------------------------

  /** Expected init failures become `status: "failed"`; unexpected ones too. */
  async boot(): Promise<void> {
    const result = await this.bootSteps();
    if (result.isErr()) {
      this.health = result.error;
    }
  }

  private async bootSteps(): Promise<Result<void, RuntimeHealth>> {
    const identity = readExecutionIdentity(process.env);
    if (identity.isErr())
      return err(this.failed("session_init_failed", identity.error.message, true));
    this.executionId = identity.value;
    this.supervisorId = process.env["PI_ORB_SUPERVISOR_ID"] ?? null;
    const fence = this.restoreIdleStopFence();
    if (fence.isErr()) return err(this.failed("session_init_failed", fence.error.message, true));
    if (this.options.testLaunchFailure === true) {
      return err(
        this.failed(
          "e2e_launch_failure",
          "test composition deliberately failed this compute incarnation",
          false,
        ),
      );
    }
    // 0. Home is ordinary durable orb state, not disposable container state
    // (docs/host-provider.md). Enforce this in the runtime as well as providers
    // so direct launches cannot inherit a shared or ephemeral host home.
    const home = configurePersistentHome(this.options.workDir);
    if (home.isErr()) {
      return err(this.failed("home_init_failed", home.error.message, false));
    }
    // 1. Rust setup and checkout are independent after HOME is configured.
    // Wait for both so a failure cannot leave background boot work running.
    this.health = this.initializing("cloning");
    const repoDir = join(this.options.workDir, "repo");
    const prerequisites = await settleBootPrerequisites(
      () =>
        ensurePersistentRustToolchain(home.value, process.env, undefined, {
          now: performance.now.bind(performance),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          report: (event, timeoutMs) => reportRustToolchainEdge(event, Math.min(20_000, timeoutMs)),
        }).mapErr((error) => this.failed("rust_toolchain_init_failed", error.message, true)),
      () => this.prepareCheckout(repoDir),
    );
    if (prerequisites.isErr()) return err(prerequisites.error);
    this.checkoutCommit = prerequisites.value[1];

    // 1b. The repository's `.agents/setup` (docs/orb-setup-hook.md) — it needs
    // the checkout, and everything after it may depend on what it installs.
    // Readiness is held while it runs; its failure never fails the boot.
    this.hooks = new BootHookRunner({
      repoDir,
      home: home.value,
      workDir: this.options.workDir,
      incarnation: this.options.incarnation ?? "0",
      task: new NoSimulationTask(`hooks-${this.options.orbId}`, false),
      spawner: this.options.hookSpawner ?? new NodeHookSpawner(),
      environment: process.env,
      log: (line) => console.log(line),
      onSetupStart: () => {
        this.health = this.initializing("setup_running");
      },
    });
    await this.hooks.runSetup();

    // 1c. Project secrets are a control-plane snapshot, fetched by the same
    // provider-neutral bearer every host already supplies. Setup deliberately
    // ran without them; resume and every later child process inherit them.
    this.health = this.initializing("checking_project_secrets");
    const broker = this.options.broker;
    if (broker === null) {
      return err(
        this.failed(
          "project_secrets_unavailable",
          "broker environment variables are missing",
          false,
        ),
      );
    }
    const projectSecrets = await fetchProjectSecretSnapshotAtBoot(broker);
    if (projectSecrets.isErr()) {
      return err(
        this.failed(
          "project_secrets_unavailable",
          projectSecrets.error.message,
          projectSecrets.error.retryable,
        ),
      );
    }
    this.hooks.addManagedEnvironmentNames(Object.keys(projectSecrets.value.values));
    for (const [name, value] of Object.entries(projectSecrets.value.values)) {
      process.env[name] = value;
    }

    const personalInstructions = await fetchPersonalInstructions(broker);
    if (personalInstructions.isErr())
      return err(
        this.failed(
          "personal_instructions_unavailable",
          personalInstructions.error.message,
          personalInstructions.error.retryable,
        ),
      );

    const projectInstructions = await fetchProjectInstructions(broker);
    if (projectInstructions.isErr())
      return err(
        this.failed(
          "project_instructions_unavailable",
          projectInstructions.error.message,
          projectInstructions.error.retryable,
        ),
      );

    // 2. Session: never replace an existing one (docs/host-provider.md).
    this.health = this.initializing("loading_session");
    const sessionDir = join(this.options.workDir, "pi-sessions");
    const managerResult = Result.fromThrowable(
      () => {
        mkdirSync(sessionDir, { recursive: true });
        // Whether to create or load is decided solely from the persistent
        // filesystem: an existing session must be loaded, and one that cannot
        // be loaded fails rather than being replaced (docs/host-provider.md).
        const existing = readdirSync(sessionDir)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(sessionDir, name))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
          .at(0);
        if (existing !== undefined) {
          return SessionManager.open(existing, sessionDir, repoDir);
        }
        return null;
      },
      (error) => (error instanceof Error ? error.message : String(error)),
    )();
    if (managerResult.isErr()) {
      // A session that exists but cannot be loaded is non-retryable — never
      // grounds for creating a fresh session.
      return err(this.failed("session_load_failed", managerResult.error, false));
    }
    const created =
      managerResult.value === null
        ? createPersistentSession(repoDir, sessionDir)
        : ok(managerResult.value);
    if (created.isErr())
      return err(this.failed("session_init_failed", created.error.message, false));
    const sessionManager = created.value;
    this.sessionManager = sessionManager;

    // 3. Codex credential resolves through the control-plane broker
    // (docs/credentials.md) — the only credential path on every provider.
    this.health = this.initializing("checking_auth");
    const mockOpenAi = this.options.mockOpenAi ?? null;
    // The package creates independent child runtimes using Pi's standard
    // agent-dir auth path. Give every session the same private broker-only
    // credential store; provider registration inheritance alone is not auth.
    const agentDir = join(this.options.workDir, "pi-agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const brokerTask = new NoSimulationTask(`broker-${this.options.orbId}`, false);
    const brokerClient = new BrokerTokenClient(new HttpBrokerEndpoint(broker, "model"));
    const runtimeResult = await ResultAsync.fromPromise(
      ModelRuntime.create({
        // Private per-orb auth file: holds only the short-lived access token
        // and the synthetic broker marker, never a refresh token.
        authPath: join(agentDir, "auth.json"),
        // Codex resolves offline from the built-in catalog; the availability
        // sweep in ModelRuntime.login can stall boots for minutes.
        allowModelNetwork: false,
      }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (runtimeResult.isErr()) {
      return err(this.failed("auth_unavailable", runtimeResult.error, true));
    }
    const modelRuntime = runtimeResult.value;
    modelRuntime.registerProvider(
      "openai-codex",
      brokerProviderConfig(brokerTask, brokerClient, {
        // E2E mode routes inference to the fake service; Pi keeps its
        // built-in Codex catalog and parser (docs/PI-CODEX-E2E.md).
        ...(mockOpenAi !== null ? { inferenceBaseUrl: mockOpenAi.inferenceBaseUrl } : {}),
      }),
    );
    const auth = await ResultAsync.fromPromise(modelRuntime.getAuth("openai-codex"), (error) =>
      error instanceof Error ? error.message : String(error),
    );
    if (auth.isErr()) {
      return err(this.failed("credential_unavailable", auth.error, true));
    }
    if (auth.value === undefined) {
      // First boot of this incarnation: pull the initial token. Pi drives
      // our broker-backed oauth `login`; no prompts are involved.
      const login = await ResultAsync.fromPromise(
        modelRuntime.login("openai-codex", "oauth", {
          prompt: (prompt) => {
            if (prompt.type === "select") {
              const first = prompt.options[0];
              if (first !== undefined) return Promise.resolve(first.id);
            }
            return Promise.reject(new Error(`unsupported auth prompt: ${prompt.type}`));
          },
          notify: () => {},
        }),
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      if (login.isErr()) {
        return err(this.failed("credential_unavailable", login.error, true));
      }
    }

    // 4. Restore per-session choices inside the brokered Codex catalog.
    const refreshed = await ResultAsync.fromPromise(
      modelRuntime.refresh({ allowNetwork: false }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (refreshed.isErr()) {
      return err(this.failed("session_init_failed", refreshed.error, true));
    }
    const eligibleModels = modelRuntime
      .getModels("openai-codex")
      .filter((item) => item.input.includes("image") && !item.id.includes("luna"));
    const restored = sessionManager.buildSessionContext();
    const restoredThinking = sessionManager
      .getEntries()
      .some((entry) => entry.type === "thinking_level_change")
      ? restored.thinkingLevel
      : null;
    const selection = restoreSessionSettings(sessionManager, eligibleModels);
    if (selection === undefined) {
      return err(this.failed("session_init_failed", "no openai-codex model available", true));
    }
    const { model, thinkingLevel } = selection;
    // 3b. `.agents/resume` runs after setup and before the session exists, so
    // the agent's first turn already sees whatever it authenticated. Its
    // outcome is awaited only for the blocking window; a slower hook keeps
    // running and only the prompt fragment misses it (docs/orb-setup-hook.md).
    await this.hooks.runResume();
    // Both hooks have had their say, so whatever they wrote to the env file is
    // merged into the runtime's own environment here — the last moment before
    // the agent exists, and what its `bash -c` tool shells and the terminal's
    // PTYs inherit. Nothing a hook *exported* ever reaches either shell
    // (docs/orb-setup-hook.md).
    const hookEnv = await this.hooks.applyHookEnv(process.env);

    const catalog = await fetchMcpCatalog(broker);
    if (catalog.isErr())
      return err(this.failed("mcp_config_unavailable", catalog.error.message, true));
    const mcpTask = new NoSimulationTask(`mcp-${this.options.orbId}`, false);
    const mcpTools = new McpTools(
      new Map(
        catalog.value.servers.map((config) => {
          const headers = resolveMcpHeaders(config, projectSecrets.value.values);
          const transport = headers.isOk()
            ? new HttpMcpTransport(
                config.url,
                headers.value,
                config.oauth
                  ? new McpCredentialResolver(
                      new HttpMcpTokenEndpoint(broker, config.oauth.id, config.url),
                    )
                  : undefined,
              )
            : { connect: async () => err(headers.error) };
          return [config.name, new McpConnection(mcpTask, transport)] as const;
        }),
      ),
    );
    // SSE keeps the first E2E deterministic; the fake refuses the WebSocket
    // transport (docs/PI-CODEX-E2E.md).
    const settingsManager =
      mockOpenAi !== null ? SettingsManager.inMemory({ transport: "sse" }) : undefined;
    // Runtime-tool availability is always appended to Pi's system prompt;
    // optional tier-1 port exposure composes through the same resource loader.
    const loaderResult = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
      settingsManager,
      previewHost: this.options.previewHost ?? null,
      hooks: this.hooks.report(),
      hookEnv,
      skillsDir: this.options.skillsDir,
      mcp: { configs: catalog.value.servers, tools: mcpTools },
      subagents: this,
      personalInstructions: personalInstructions.value,
      projectInstructions: projectInstructions.value,
    });
    if (loaderResult.isErr()) {
      return err(this.failed("session_init_failed", loaderResult.error, true));
    }
    const sessionResult = await ResultAsync.fromPromise(
      createAgentSession({
        cwd: repoDir,
        agentDir,
        modelRuntime,
        sessionManager,
        model,
        thinkingLevel,
        ...(settingsManager !== undefined ? { settingsManager } : {}),
        resourceLoader: loaderResult.value,
      }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (sessionResult.isErr()) {
      return err(this.failed("session_init_failed", sessionResult.error, true));
    }
    const sdkSession = sessionResult.value.session;

    let binding = true;
    let startupExtensionError = false;
    const bound = await ResultAsync.fromPromise(
      sdkSession.bindExtensions({
        mode: "print",
        onError: (error) => {
          startupExtensionError ||= binding;
          const saved = Result.fromThrowable(
            () =>
              sessionManager.appendCustomMessageEntry(
                "pi-orb:extension-error",
                `Pi extension failed: ${error.extensionPath} (${error.event})`,
                true,
              ),
            () => "Cannot record Pi extension failure",
          )();
          if (saved.isErr())
            this.health = this.failed("extension_error_record_failed", saved.error, false);
        },
      }),
      () => "Pi extensions could not start",
    );
    binding = false;
    if (bound.isErr() || startupExtensionError) {
      await mcpTools.close();
      sdkSession.dispose();
      return err(this.failed("extension_init_failed", "Pi extensions could not start", false));
    }
    this.shutdownExtensions = async () => {
      await ResultAsync.fromPromise(
        sdkSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
        () => "Pi extension shutdown failed",
      );
      await mcpTools.close();
      Result.fromThrowable(
        () => sdkSession.dispose(),
        () => "Pi disposal failed",
      )();
    };
    const adoption = Result.fromThrowable(
      () => {
        const entries = sessionManager.getEntries();
        const previous = entries.findLast(
          (entry) => entry.type === "custom" && entry.customType === "pi-orb:mcp-config",
        );
        const data = {
          revision: catalog.value.revision,
          servers: catalog.value.servers.map((server) => server.name),
          secretRevision: projectSecrets.value.revision,
        };
        if (
          (catalog.value.servers.length > 0 || previous) &&
          (previous?.type !== "custom" || JSON.stringify(previous.data) !== JSON.stringify(data))
        )
          sessionManager.appendCustomEntry("pi-orb:mcp-config", data);
      },
      () => "Cannot record MCP configuration adoption",
    )();
    if (adoption.isErr()) {
      await this.closeExtensions();
      return err(this.failed("mcp_config_record_failed", adoption.error, false));
    }
    for (const [scope, customType, snapshot] of [
      ["personal", PERSONAL_INSTRUCTIONS_ADOPTION, personalInstructions.value],
      ["project", PROJECT_INSTRUCTIONS_ADOPTION, projectInstructions.value],
    ] as const) {
      const recorded = Result.fromThrowable(
        () => {
          const previous = sessionManager
            .getEntries()
            .findLast((entry) => entry.type === "custom" && entry.customType === customType);
          const edge = instructionsAdoption(
            snapshot,
            previous?.type === "custom" ? previous.data : null,
          );
          if (edge !== null) sessionManager.appendCustomEntry(customType, edge);
        },
        () => `Cannot record ${scope} instructions adoption`,
      )();
      if (recorded.isErr()) {
        await this.closeExtensions();
        return err(this.failed(`${scope}_instructions_record_failed`, recorded.error, false));
      }
    }
    const readSettings = (): AgentSettings => ({
      model: {
        provider: sdkSession.model?.provider ?? model.provider,
        id: sdkSession.model?.id ?? model.id,
      },
      thinkingLevel: sdkSession.thinkingLevel,
    });
    const fallback = settingsFallbackMessage(restored.model, restoredThinking, readSettings());
    if (fallback !== null) {
      const recorded = Result.fromThrowable(
        () =>
          sessionManager.appendCustomEntry("pi-orb.settings-fallback", {
            message: fallback,
          }),
        () => "Cannot record model fallback",
      )();
      if (recorded.isErr()) return err(this.failed("session_init_failed", recorded.error, false));
    }
    const file = sessionManager.getSessionFile();
    if (!file) return err(this.failed("session_init_failed", "No persistent session file", false));
    const durable = syncSessionFile(file);
    if (durable.isErr())
      return err(this.failed("session_init_failed", durable.error.message, false));
    this.settingsController = new AgentSettingsController({
      task: new NoSimulationTask(`settings-${this.options.orbId}`, false),
      initial: readSettings(),
      models: eligibleModels.map((item) => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        thinkingLevels: getSupportedThinkingLevels(item),
      })),
      isIdle: () =>
        this.health.status === "ready" && this.activity === "idle" && this.turnStart === null,
      publish: (view) => this.broadcastEvent(view),
      onFailure: (error) => {
        this.health = this.failed("settings_failed", error.message, false);
      },
      apply: async (action) => {
        const authenticated = await ResultAsync.fromPromise(
          modelRuntime.checkAuth(model.provider),
          () => ({
            type: "settings_error" as const,
            message: "Model authentication is unavailable.",
            unchanged: true,
          }),
        );
        if (authenticated.isErr()) return err(authenticated.error);
        if (!authenticated.value)
          return err({
            type: "settings_error" as const,
            message: "Model authentication is unavailable.",
            unchanged: true,
          });
        const previousThinking = sdkSession.thinkingLevel;
        const changed = await ResultAsync.fromPromise(
          (async () => {
            if (action.type === "set_model") {
              const target = eligibleModels.find(
                (item) => item.provider === action.model.provider && item.id === action.model.id,
              );
              if (target) await sdkSession.setModel(target);
              sdkSession.setThinkingLevel(previousThinking);
            } else sdkSession.setThinkingLevel(action.thinkingLevel);
          })(),
          () => ({
            type: "settings_error" as const,
            message: "Cannot apply agent settings; runtime recovery is required.",
          }),
        );
        if (changed.isErr()) {
          this.health = this.failed("settings_failed", changed.error.message, false);
          return err(changed.error);
        }
        const persisted = syncSessionFile(file);
        if (persisted.isErr()) {
          this.health = this.failed("settings_failed", persisted.error.message, false);
          return err(persisted.error);
        }
        const published = this.liveHistory?.flushPersisted();
        if (published?.isErr()) {
          this.health = this.failed("settings_failed", published.error.message, false);
          return err({ type: "settings_error" as const, message: published.error.message });
        }
        return ok(readSettings());
      },
    });
    this.observeSettings = () => {
      const controller = this.settingsController;
      if (!controller || controller.blocksInput) return;
      const current = readSettings();
      if (JSON.stringify(current) === JSON.stringify(controller.view.settings)) return;
      const persisted = syncSessionFile(file);
      if (persisted.isErr()) {
        controller.invalidate(persisted.error);
        return;
      }
      const published = this.liveHistory?.flushPersisted();
      if (published?.isErr()) {
        controller.invalidate({ type: "settings_error", message: published.error.message });
        return;
      }
      controller.observe(current);
    };
    sdkSession.subscribe(() => this.observeSettings?.());
    const summarizer = this.options.turnSummarizer ?? new LunaTurnSummarizer(modelRuntime, model);
    this.attachSession(sessionResult.value.session, sessionManager, summarizer);
    return ok(undefined);
  }

  /** Fresh temp clone plus atomic rename, or validation of the reused checkout. */
  private async prepareCheckout(repoDir: string): Promise<Result<string, RuntimeHealth>> {
    if (!existsSync(repoDir)) {
      const url = validateRepositoryUrl(this.options.repositoryUrl);
      if (url.isErr()) {
        return err(this.failed("invalid_repository_url", url.error.message, false));
      }
      const tmpDir = join(this.options.workDir, ".clone-tmp");
      const cleaned = Result.fromThrowable(
        () => {
          rmSync(tmpDir, { recursive: true, force: true });
          mkdirSync(this.options.workDir, { recursive: true });
        },
        (error) => String(error),
      )();
      if (cleaned.isErr()) return err(this.failed("clone_failed", cleaned.error, true));
      const cloned = await execGit(["clone", "--", url.value.url, tmpDir], this.options.workDir);
      if (cloned.isErr()) return err(this.failed("clone_failed", cloned.error.message, true));
      const renamed = Result.fromThrowable(
        () => renameSync(tmpDir, repoDir),
        (error) => String(error),
      )();
      if (renamed.isErr()) return err(this.failed("clone_failed", renamed.error, true));
    }
    const commit = await execGit(["rev-parse", "HEAD"], repoDir);
    if (commit.isErr()) return err(this.failed("clone_failed", commit.error.message, true));
    return ok(commit.value);
  }

  /**
   * Boot's final step, separated as the harness seam (docs/testing.md): wire
   * the live publisher, the summary coordinator, and the Pi event
   * subscription around a created session, report ready, and run the
   * interrupted-turn hook. Deterministic tests drive this directly with a
   * scheduled fake session instead of booting a model runtime.
   */
  attachSession(
    session: PiSession,
    manager: PiSessionManager,
    summarizer: TurnSummarizer,
    settingsController: AgentSettingsController | null = this.settingsController,
  ): void {
    this.settingsController = settingsController;
    this.session = session;
    this.sessionManager = manager;
    this.summaryCoordinator = new TurnSummaryCoordinator({
      task: new NoSimulationTask(`turn-summary-${this.options.orbId}`, false),
      summarizer,
      timeoutMs: 15_000,
      maxConcurrency: 2,
      maxQueued: 8,
      onSummary: (operationId, summary) => {
        console.log(
          `Luna summary completed operation=${operationId} chars=${summary.length} live_connections=${this.listeners.size}`,
        );
        this.broadcastEvent({ type: "turn_notification", operationId, summary });
      },
      onError: (operationId, error) => {
        console.error(`Luna summary failed for operation ${operationId}: ${error.message}`);
      },
    });
    this.liveHistory = new LiveHistoryPublisher(manager, (record, sourceMessage) => {
      const native = record.overflow["native"];
      if (typeof native === "object" && native !== null && !Array.isArray(native)) {
        const details = native["details"];
        if (
          native["type"] === "custom_message" &&
          native["customType"] === "pi-orb.user-message" &&
          typeof details === "object" &&
          details !== null &&
          !Array.isArray(details)
        ) {
          const messageIds = details["messageIds"];
          const batchId = Array.isArray(messageIds) ? messageIds[0] : details["messageId"];
          if (typeof batchId === "string") this.pendingInboxMessages.delete(batchId);
        }
      }
      const retiredBlockIds =
        sourceMessage === null ? [] : (this.messageBlocks.get(sourceMessage) ?? []);
      if (sourceMessage !== null) this.messageBlocks.delete(sourceMessage);
      // Update reconnect state before publishing the indivisible browser handoff.
      for (const id of retiredBlockIds) this.liveBlocks.delete(id);
      this.broadcast({
        v: 1,
        type: "history.record",
        retiredBlockIds,
        at: new Date().toISOString(),
        record,
        headId: record.id,
      });
    });
    session.subscribe((event) => this.onAgentEvent(event));

    this.health = {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "ready",
      sessionId: manager.getSessionId(),
      checkoutCommit: this.checkoutCommit,
      activity: this.activity,
    };
    const firstUser = this.snapshot().map((snapshot) =>
      snapshot.records.find((record) => record.type === "message" && record.role === "user"),
    );
    if (firstUser.isOk() && firstUser.value !== undefined && firstUser.value.type === "message") {
      const content: MessageInputBlock[] = firstUser.value.content.flatMap(
        (block): MessageInputBlock[] =>
          block.type === "text"
            ? [{ type: "text" as const, text: block.text }]
            : block.type === "image"
              ? [{ type: "image" as const, mediaType: block.mediaType ?? "image/png", data: "" }]
              : [],
      );
      this.triggerAutoName(content);
    }

    // 5. Deliver restart context, including between turns (docs/lifecycle.md).
    // This synchronous final boot step claims any automatic turn before
    // another ingress can observe readiness; inference is never awaited.
    this.notifyRestart(manager, session);
  }

  /**
   * Boot's restart-context hook. The marker is appended and its turn is
   * triggered without blocking readiness — with `triggerTurn` the SDK settles
   * its promise only when the whole resumed turn does, so awaiting it here
   * would hold the runtime in `initializing` for the length of a turn. The
   * decision is kept for `RuntimeHealth`, where the control plane's readiness
   * path turns it into one log line (docs/lifecycle.md).
   */
  private notifyRestart(manager: PiSessionManager, session: PiSession): void {
    const identity = {
      runtimeInstanceId: this.runtimeInstanceId,
      executionId:
        this.options.executionId === undefined ? this.executionId : this.options.executionId,
      incarnation: this.options.incarnation ?? "0",
    };
    const toError = (cause: unknown) => ({
      type: "boot_notification_error" as const,
      message: String(cause),
    });
    const loaded = Result.fromThrowable(
      () => ({
        entries: manager.getEntries(),
        context: manager.buildContextEntries(),
      }),
      toError,
    )();
    if (loaded.isErr()) {
      this.health = this.failed("session_init_failed", loaded.error.message, true);
      return;
    }
    const fence = this.restoreIdleStopFence();
    if (fence.isErr()) {
      this.health = this.failed("session_init_failed", fence.error.message, true);
      return;
    }
    if (fence.value) return;
    const plan = planBootNotification(loaded.value.entries, loaded.value.context, identity);
    if (plan.kind === "none") return;
    if (plan.kind === "baseline") {
      const saved = Result.fromThrowable(
        () => manager.appendCustomEntry(BOOT_BASELINE_TYPE, identity),
        toError,
      )();
      if (saved.isErr())
        this.health = this.failed("session_init_failed", saved.error.message, true);
      return;
    }
    this.turnResume = {
      ...(plan.marker.details.shape !== undefined ? { shape: plan.marker.details.shape } : {}),
      outcome:
        plan.marker.details.reason === "resumed"
          ? "resumed"
          : plan.triggerTurn
            ? "notified_restart"
            : "declined_already_resumed",
      ...(plan.marker.details.headRecordId !== null
        ? { headRecordId: plan.marker.details.headRecordId }
        : {}),
    };
    // Claim synchronously, before the SDK's asynchronous agent_start event.
    // Incoming inbox deliveries wait on the same turn-start barrier as a
    // human-started turn; readiness never awaits inference completion.
    const operationId = plan.triggerTurn ? randomUUID() : null;
    if (operationId !== null) {
      this.startAgentOperation(operationId, null);
      this.beginTurnStart();
    }
    const interrupted = interruptedSubagents(loaded.value.entries);
    const marker =
      interrupted.length === 0
        ? plan.marker
        : {
            ...plan.marker,
            content: `${plan.marker.content} Local subagent runs (${interrupted.map((run) => run.childId).join(", ")}) were interrupted. They have not been automatically replayed; inspect existing work before deciding what is still needed.`,
            details: { ...plan.marker.details, interruptedSubagents: interrupted },
          };
    const send = ResultAsync.fromThrowable(
      () => session.sendCustomMessage(marker, { triggerTurn: plan.triggerTurn }),
      toError,
    );
    void send().mapErr((error) => {
      this.turnResume = { ...this.turnResume, outcome: "resume_failed" };
      if (operationId !== null) this.abandonAgentOperation(operationId, error.message);
      // A durable, visible failure also covers runtimes that restart without
      // crossing a control-plane readiness edge. No stdout-only decisions.
      const saved = Result.fromThrowable(
        () =>
          manager.appendCustomMessageEntry(
            "pi-orb.restart-notification-failed",
            `The runtime could not deliver its restart notification: ${error.message}`,
            true,
            {
              ...identity,
              reason: "delivery_failed",
              headRecordId: plan.marker.details.headRecordId,
            },
          ),
        toError,
      )();
      if (saved.isErr())
        this.health = this.failed("session_init_failed", saved.error.message, true);
      this.liveHistory?.observe("message_end");
      return error;
    });
  }

  // -- Pi event translation (docs/runtime-protocol.md) --------------------------------

  private onAgentEvent(event: AgentSessionEvent): void {
    // Pi notifies subscribers of ordinary message_end before appending the
    // corresponding session entry. The publisher scans after that boundary
    // and flushes synchronously at agent_settled before live state is cleared.
    this.liveHistory?.observe(event.type);

    switch (event.type) {
      case "agent_start": {
        if (this.idleStopPrepared) {
          const session = this.session;
          if (session !== null)
            void ResultAsync.fromThrowable(
              () => session.abort(),
              (cause) => ({ message: String(cause) }),
            )().mapErr((error) => {
              this.health = this.failed("idle_stop_fence_failed", error.message, true);
              return error;
            });
          break;
        }
        // A submitted turn claimed its operation synchronously at acceptance,
        // and Pi re-emits agent_start for continuations inside the same run
        // (auto-retry, auto-compaction): neither may restart the operation or
        // change its ID. Only an SDK/extension turn nobody claimed allocates
        // here; boot notifications now claim their operation before Pi starts.
        if (this.operationKind === null) this.startAgentOperation(randomUUID(), null);
        this.settleTurnStart();
        break;
      }
      case "message_start": {
        if (event.message.role === "assistant") this.outputMessageSequence++;
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant" || this.operationId === null) break;
        // Pi stores this same message object in its session entry after notifying
        // subscribers. Bind identity now, before persistence or a newer response.
        const prefix = `${this.operationId}-${this.outputMessageSequence}-`;
        this.messageBlocks.set(
          event.message,
          [...this.liveBlocks.keys()].filter((id) => id.startsWith(prefix)),
        );
        break;
      }
      case "message_update": {
        if (this.operationId === null) break;
        const message = event.message as { role?: string; content?: unknown };
        if (message.role !== "assistant" || !Array.isArray(message.content)) break;
        message.content.forEach((block: unknown, index: number) => {
          if (typeof block !== "object" || block === null) return;
          const typed = block as { type?: string; text?: string; thinking?: string };
          const blockType =
            typed.type === "text" ? "text" : typed.type === "thinking" ? "reasoning" : null;
          if (blockType === null) return;
          const text = blockType === "text" ? (typed.text ?? "") : (typed.thinking ?? "");
          const blockId = `${this.operationId}-${this.outputMessageSequence}-${index}`;
          const existing = this.liveBlocks.get(blockId);
          if (existing !== undefined && existing.text === text) return;
          const revision = (existing?.revision ?? 0) + 1;
          this.liveBlocks.set(blockId, { blockType, revision, text });
          if (this.operationId === null) return;
          this.broadcastEvent({
            type: "output_patch",
            operationId: this.operationId,
            blockId,
            blockType,
            revision,
            patch:
              existing !== undefined && text.startsWith(existing.text)
                ? { type: "append", text: text.slice(existing.text.length) }
                : { type: "replace", text },
          });
        });
        break;
      }
      case "tool_execution_start": {
        if (this.operationId === null) break;
        this.liveTools.set(event.toolCallId, {
          name: event.toolName,
          revision: 1,
          state: "running",
        });
        this.broadcastEvent({
          type: "tool_state",
          operationId: this.operationId,
          callId: event.toolCallId,
          name: event.toolName,
          revision: 1,
          state: "running",
        });
        break;
      }
      case "tool_execution_end": {
        if (this.operationId === null) break;
        const existing = this.liveTools.get(event.toolCallId);
        const revision = (existing?.revision ?? 0) + 1;
        const state = event.isError ? "failed" : "completed";
        this.liveTools.set(event.toolCallId, {
          name: event.toolName,
          revision,
          state,
        });
        this.broadcastEvent({
          type: "tool_state",
          operationId: this.operationId,
          callId: event.toolCallId,
          name: event.toolName,
          revision,
          state,
        });
        break;
      }
      case "agent_settled": {
        if (this.operationKind !== "agent") break;
        this.maybeFinishAgentOperation();
        break;
      }
      default:
        break;
    }
  }

  /**
   * Claim the runtime for an agent operation at the instant its submission is
   * accepted, exactly as a shell submission does (docs/runtime-protocol.md).
   * Activity is what both ingress paths gate on, so it must not lag
   * acceptance: a second submitter reading `idle` during the window before
   * Pi's `agent_start` would be promised an operation ID for a turn that
   * never becomes its own.
   */
  private startAgentOperation(operationId: string, summaryStartIndex: number | null): void {
    this.operationId = operationId;
    this.operationKind = "agent";
    this.operationOutcome = "completed";
    this.operationError = undefined;
    this.activity = "busy";
    this.summaryStartIndex = summaryStartIndex;
    this.liveBlocks.clear();
    this.liveTools.clear();
    this.broadcastEvent({ type: "operation_started", operationId });
    this.broadcastEvent({ type: "status", activity: "busy", operationId });
  }

  private finishAgentOperation(
    operationId: string | null,
    outcome: "completed" | "aborted" | "failed",
    message?: string,
  ): void {
    this.operationId = null;
    this.operationKind = null;
    this.activity = "idle";
    this.liveBlocks.clear();
    this.liveTools.clear();
    // A turn that ends without ever starting still releases its waiters.
    this.settleTurnStart();
    if (operationId !== null) {
      this.broadcastEvent({
        type: "operation_finished",
        operationId,
        outcome,
        ...(message !== undefined ? { message } : {}),
      });
    }
    this.broadcastEvent({ type: "status", activity: "idle" });
  }

  /**
   * A submission Pi refused releases the operation it claimed, so the runtime
   * cannot be left busy on a turn that will never run — and the failure is
   * visible to the browser as a finished operation instead of silence.
   */
  private abandonAgentOperation(operationId: string, message: string): void {
    if (this.operationId !== operationId || this.operationKind !== "agent") return;
    if (this.operationOutcome !== "aborted") {
      this.operationOutcome = "failed";
      this.operationError = message;
    }
    this.settleTurnStart();
    this.maybeFinishAgentOperation();
  }

  /** Public adapter seam: reserve before the extension can yield into child work. */
  admitSubagent(childId: string, description = childId): Result<SubagentRun, SubagentError> {
    if (
      this.health.status !== "ready" ||
      this.idleStopPrepared ||
      this.settingsController?.blocksInput ||
      this.operationOutcome === "aborted" ||
      this.operationKind === "shell"
    )
      return err({
        type: "subagent_admission_rejected",
        message: "The current operation is not accepting subagents",
      });
    if (this.operationId === null)
      this.startAgentOperation(randomUUID(), this.sessionManager?.getEntries().length ?? null);
    const operationId = this.operationId;
    if (operationId === null)
      return err({
        type: "subagent_admission_rejected",
        message: "No agent operation owns this subagent",
      });
    return this.subagentWork
      .admit(childId, operationId, description)
      .map((run) => {
        this.publishSubagents();
        return run;
      })
      .mapErr(
        (): SubagentError => ({
          type: "subagent_admission_rejected",
          message: "Subagent already belongs to another operation",
        }),
      );
  }

  startSubagent(run: SubagentRun): void {
    if (this.subagentWork.start(run)) this.publishSubagents();
  }

  private publishSubagents(): void {
    if (this.operationId !== null)
      this.broadcastEvent({
        type: "subagents",
        operationId: this.operationId,
        children: [...this.subagentWork.view],
      });
  }

  releaseSubagent(run: SubagentRun): void {
    if (this.subagentWork.release(run)) this.publishSubagents();
    this.maybeFinishAgentOperation();
  }

  mayWakeSubagent(childId: string): boolean {
    const allowed =
      !this.idleStopPrepared &&
      this.operationOutcome !== "aborted" &&
      this.subagentWork.mayWake(childId, this.operationId);
    if (!allowed) {
      // Withheld notifications can reach delivery after execution cleanup;
      // correlation outlives the active hold so their veto is still durable.
      const run = this.subagentWork.correlation(childId);
      const saved = Result.fromThrowable(
        () =>
          this.sessionManager?.appendCustomEntry("pi-orb.subagent-run", {
            ...(run ?? { childId }),
            phase: "wake_suppressed",
          }),
        (error) => (error instanceof Error ? error.message : String(error)),
      )();
      if (saved.isErr()) this.subagentAdapterFailed(saved.error);
    }
    return allowed;
  }

  subagentAdapterFailed(message: string): void {
    this.health = this.failed("subagent_adapter_failed", message, false);
  }

  bindSubagentAbort(abort: () => Result<void, SubagentError>): void {
    this.abortSubagents = abort;
  }

  private maybeFinishAgentOperation(): void {
    if (
      this.health.status !== "ready" ||
      this.operationKind !== "agent" ||
      this.session === null ||
      !this.session.isIdle ||
      this.turnStart !== null ||
      this.subagentWork.busy
    )
      return;
    const published = this.liveHistory?.flushPersisted();
    if (published?.isErr()) {
      this.health = this.failed("subagent_history_failed", published.error.message, false);
      return;
    }
    const operationId = this.operationId;
    const summary = this.captureTurnSummaryInput();
    const outcome = this.operationOutcome;
    this.finishAgentOperation(operationId, outcome, this.operationError);
    if (outcome === "completed" && operationId !== null && summary !== null)
      this.summaryCoordinator?.enqueue(operationId, summary);
  }

  /** Resolves once no accepted submission is still waiting for `agent_start`. */
  private awaitTurnStart(): Promise<void> {
    return this.turnStart?.promise ?? Promise.resolve();
  }

  private beginTurnStart(): void {
    if (this.turnStart !== null) return;
    let resolve = (): void => {};
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.turnStart = { promise, resolve };
  }

  private settleTurnStart(): void {
    const pending = this.turnStart;
    this.turnStart = null;
    pending?.resolve();
  }

  private captureTurnSummaryInput() {
    const manager = this.sessionManager;
    const startIndex = this.summaryStartIndex;
    this.summaryStartIndex = null;
    if (manager === null || startIndex === null) return null;

    const records: HistoryRecord[] = [];
    for (const entry of manager.getEntries().slice(startIndex)) {
      const mapped = mapPiEntry(entry);
      if (mapped.isErr()) {
        console.error(`Luna summary input mapping failed: ${mapped.error.message}`);
        return null;
      }
      const data: unknown = entry.type === "custom" ? entry.data : null;
      if (
        entry.type === "custom" &&
        entry.customType === "subagents:record" &&
        data !== null &&
        typeof data === "object" &&
        "status" in data &&
        (data.status === "completed" || data.status === "error") &&
        "description" in data &&
        typeof data.description === "string"
      ) {
        // Summary-only projection: include delegated outcome/intent, never
        // separate child transcripts or raw child/tool output.
        records.push({
          ...mapped.value,
          type: "message",
          role: "tool",
          content: [{ type: "text", text: `[subagent ${data.status}] ${data.description}` }],
        });
      } else records.push(mapped.value);
    }
    return buildTurnSummaryInput(records);
  }

  // -- synchronous views ----------------------------------------------------

  /**
   * The snapshot served to the control plane's history pull
   * (docs/history-replication.md): empty until the SDK has written the session file (no assistant
   * message yet, pinned in session-flush.contract.test.ts), because every
   * entry before that is memory-only and a committed cursor naming one would
   * be unresolvable after a restart. Browser-facing views use `snapshot()`
   * ungated — gating only part of them desynchronizes the head the client
   * sees from the head its requests are validated against (stale_head).
   */
  replicationSnapshot(): Result<HarnessSnapshot, SnapshotError> {
    const manager = this.sessionManager;
    if (manager === null) {
      return err({ type: "snapshot_error", message: "session is not ready" });
    }
    return this.snapshot().map((snapshot) =>
      gateUnflushedSnapshot(snapshot, sessionFlushed(manager)),
    );
  }

  /** Immutable snapshot of the full in-memory session (docs/history-replication.md). */
  snapshot(): Result<HarnessSnapshot, SnapshotError> {
    this.observeSettings?.();
    const manager = this.sessionManager;
    if (manager === null || this.health.status !== "ready") {
      return err({ type: "snapshot_error", message: "session is not ready" });
    }
    // A reconnect can snapshot between Pi append and the scheduled publication.
    // Drain that boundary before pairing persisted records with liveView().
    const flushed = this.liveHistory?.flushPersisted();
    if (flushed?.isErr()) return err({ type: "snapshot_error", message: flushed.error.message });
    const header = mapPiSessionHeader(manager.getHeader());
    if (header.isErr()) {
      return err({ type: "snapshot_error", message: header.error.message });
    }
    const records = [];
    for (const entry of manager.getEntries()) {
      const mapped = mapPiEntry(entry);
      // A mapping failure must fail the pull, never skip an entry (docs/pi-adapter.md).
      if (mapped.isErr()) {
        return err({ type: "snapshot_error", message: mapped.error.message });
      }
      records.push(mapped.value);
    }
    return ok({
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      activity: this.activity,
      session: header.value,
      records,
      headId: manager.getLeafId(),
      settings: this.settingsController?.view ?? null,
    });
  }

  private restoreIdleStopFence(): Result<boolean, { message: string }> {
    const lifetimeId = this.admissionLifetime();
    if (lifetimeId === null) return ok(false);
    return this.idleStopFence
      .read()
      .map((saved) => {
        this.idleStopPrepared = saved === lifetimeId;
        return this.idleStopPrepared;
      })
      .mapErr((error) => {
        this.idleStopPrepared = true;
        return error;
      });
  }

  private admissionLifetime(): string | null {
    const executionId =
      this.options.executionId === undefined ? this.executionId : this.options.executionId;
    if (executionId !== null) return `host:${executionId}`;
    return this.supervisorId === null ? null : `supervisor:${this.supervisorId}`;
  }

  /** Claim an idle runtime before the control plane drains and stops its host.
   * The execution-scoped fact survives supervisor restarts, but not a new host boot.
   */
  prepareIdleStop(): Result<boolean, { message: string }> {
    if (this.health.status === "failed") return err({ message: this.health.error.message });
    if (this.health.status !== "ready" || this.sessionManager === null)
      return err({ message: "session is not ready" });
    if (this.idleStopPrepared) return ok(true);
    if (this.activity === "busy" || this.settingsController?.blocksInput) return ok(false);
    const lifetimeId = this.admissionLifetime();
    if (lifetimeId === null) return err({ message: "admission lifetime is unavailable" });
    // A failed append may have committed. Never reopen admission on an
    // uncertain persistence outcome; health exposes the failure instead.
    this.idleStopPrepared = true;
    const persisted = this.idleStopFence.write(lifetimeId);
    if (persisted.isErr()) {
      this.health = this.failed("session_init_failed", persisted.error.message, true);
      return err(persisted.error);
    }
    const saved = Result.fromThrowable(
      () =>
        this.sessionManager?.appendCustomEntry("pi-orb.idle-stop-prepared", {
          lifetimeId,
          runtimeInstanceId: this.runtimeInstanceId,
        }),
      (cause) => ({ message: String(cause) }),
    )();
    if (saved.isErr()) {
      this.health = this.failed("session_init_failed", saved.error.message, true);
      return err(saved.error);
    }
    this.liveHistory?.observe("message_end");
    return ok(true);
  }

  gateView(): AgentGateView {
    return {
      acceptingWork: !this.idleStopPrepared,
      activity: this.activity,
      headId: this.sessionManager?.getLeafId() ?? null,
      activeOperationId: this.operationId,
      configuring: this.settingsController?.blocksInput ?? false,
    };
  }

  changeSettings(action: SettingsAction) {
    if (this.idleStopPrepared)
      return errAsync({ code: "busy" as const, message: "Runtime is preparing to stop." });
    return (
      this.settingsController?.change(action) ??
      ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ code: "unsupported" as const, message: "Agent settings are unavailable." }),
      )
    );
  }

  liveView(): LiveOperationView | null {
    if (this.operationId === null) return null;
    return {
      operationId: this.operationId,
      operationKind: this.operationKind ?? "agent",
      subagents: this.subagentWork.view,
      blocks: [...this.liveBlocks.entries()].map(([blockId, block]) => ({
        blockId,
        blockType: block.blockType,
        revision: block.revision,
        text: block.text,
      })),
      tools: [...this.liveTools.entries()].map(([callId, tool]) => ({
        callId,
        name: tool.name,
        revision: tool.revision,
        state: tool.state,
        ...(tool.message !== undefined ? { message: tool.message } : {}),
      })),
    };
  }

  sessionId(): string | null {
    return this.sessionManager?.getSessionId() ?? null;
  }

  /** Trigger first-message naming without delaying or failing the agent turn. */
  triggerAutoName(content: readonly MessageInputBlock[]): void {
    if (this.autoNameTriggered) return;
    this.autoNameTriggered = true;
    const broker = this.options.broker;
    if (broker === null) return;
    const text = content
      .filter(
        (block): block is Extract<MessageInputBlock, { type: "text" }> => block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    const textBytes = Buffer.from(text);
    const boundedText = textBytes.subarray(0, ORB_NAME_MESSAGE_MAX_BYTES).toString("utf8");
    const imageOnly = boundedText.trim() === "" && content.some((block) => block.type === "image");
    const checkoutDir = join(this.options.workDir, "repo");
    void readRootReadme(checkoutDir, ORB_NAME_README_MAX_BYTES).then(async (readme) => {
      const sent = await triggerOrbName(broker, {
        text: boundedText,
        imageOnly,
        ...(readme.isOk() && readme.value !== null ? { readme: readme.value } : {}),
      });
      if (sent.isErr()) console.error(`orb naming unavailable: ${sent.error.message}`);
    });
  }

  /**
   * Deliver one frozen inbox batch (docs/runtime-protocol.md). The delivery
   * classification is derived from the runtime's activity at the instant of
   * the call, so the call first waits out any accepted submission that has
   * not reached `agent_start` yet: inside that window Pi still looks idle to
   * itself, and a message the runtime classified as a steer would start a
   * second, competing turn.
   */
  deliverInboxMessage(
    messageId: string,
    messageIds: readonly string[],
    content: readonly MessageInputBlock[],
  ): ResultAsync<DeliverOrbMessageResponse, { message: string; retryable: boolean }> {
    return ResultAsync.fromSafePromise(this.awaitTurnStart()).andThen(() =>
      this.deliverSettledInboxMessage(messageId, messageIds, content),
    );
  }

  private deliverSettledInboxMessage(
    messageId: string,
    messageIds: readonly string[],
    content: readonly MessageInputBlock[],
  ): ResultAsync<DeliverOrbMessageResponse, { message: string; retryable: boolean }> {
    const session = this.session;
    const manager = this.sessionManager;
    if (
      this.idleStopPrepared ||
      session === null ||
      manager === null ||
      this.health.status !== "ready"
    ) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready", retryable: true }),
      );
    }
    for (const entry of manager.getEntries()) {
      if (typeof entry !== "object" || entry === null) continue;
      const native = entry as { type?: string; customType?: string; details?: unknown };
      if (native.type !== "custom_message" || native.customType !== "pi-orb.user-message") continue;
      const details = native.details;
      if (typeof details !== "object" || details === null) continue;
      const typed = details as {
        messageId?: unknown;
        messageIds?: unknown;
        delivery?: unknown;
        operationId?: unknown;
      };
      const persistedIds = Array.isArray(typed.messageIds) ? typed.messageIds : [typed.messageId];
      if (persistedIds[0] !== messageId) continue;
      return ResultAsync.fromSafePromise(
        Promise.resolve({
          v: 1 as const,
          messageId,
          status: "persisted" as const,
          delivery: typed.delivery === "steer" ? ("steer" as const) : ("turn" as const),
          operationId: typeof typed.operationId === "string" ? typed.operationId : "unknown",
          duplicate: true,
        }),
      );
    }
    const pending = this.pendingInboxMessages.get(messageId);
    if (pending !== undefined) {
      return ResultAsync.fromSafePromise(
        Promise.resolve({
          v: 1 as const,
          messageId,
          status: "queued" as const,
          ...pending,
          duplicate: true,
        }),
      );
    }
    if (this.operationKind === "shell") {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "a foreground shell command is running", retryable: true }),
      );
    }
    if (this.operationKind === "agent" && this.operationOutcome === "aborted")
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "The previous operation is still cancelling", retryable: true }),
      );
    if (this.settingsController?.blocksInput)
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "Agent settings are changing", retryable: true }),
      );
    const delivery: "turn" | "steer" = session.isIdle ? "turn" : "steer";
    const operationId = this.operationId ?? randomUUID();
    this.pendingInboxMessages.set(messageId, { delivery, operationId });
    if (delivery === "turn") {
      if (this.operationId === null)
        this.startAgentOperation(operationId, manager.getEntries().length);
      this.beginTurnStart();
    }
    const piContent = content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "image" as const, data: block.data, mimeType: block.mediaType },
    );
    this.triggerAutoName(content);
    return ResultAsync.fromPromise(
      session.sendCustomMessage(
        {
          customType: "pi-orb.user-message",
          content: piContent,
          display: true,
          details: { messageIds, delivery, operationId },
        },
        { triggerTurn: true, ...(delivery === "steer" ? { deliverAs: "steer" as const } : {}) },
      ),
      (error) => ({
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      }),
    )
      .map(() => ({
        v: 1 as const,
        messageId,
        status: "queued" as const,
        delivery,
        operationId,
        duplicate: false,
      }))
      .mapErr((error) => {
        this.pendingInboxMessages.delete(messageId);
        if (delivery === "turn") this.abandonAgentOperation(operationId, error.message);
        return error;
      });
  }

  /**
   * Submit a user message under the operation ID already promised to the
   * requester; resolves once Pi has accepted/persisted it. The operation is
   * claimed here, synchronously with acceptance, so no concurrent submitter
   * can be handed the same turn.
   */
  submitMessage(
    content: readonly MessageInputBlock[],
    operationId: string,
  ): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (this.idleStopPrepared || session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not accepting work" }),
      );
    }
    this.startAgentOperation(operationId, this.sessionManager?.getEntries().length ?? null);
    this.beginTurnStart();
    const piContent = content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "image" as const, data: block.data, mimeType: block.mediaType },
    );
    return ResultAsync.fromPromise(
      Promise.resolve(session.sendUserMessage(piContent)),
      (error) => ({
        message: error instanceof Error ? error.message : String(error),
      }),
    )
      .map(() => undefined)
      .mapErr((error) => {
        this.abandonAgentOperation(operationId, error.message);
        return error;
      });
  }

  submitShell(
    command: string,
    excludeFromContext: boolean,
    operationId: string,
  ): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (this.idleStopPrepared || session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not accepting work" }),
      );
    }

    this.startShellOperation(command, operationId);
    const execution = ResultAsync.fromPromise(
      session.executeBash(command, (chunk) => this.appendShellOutput(operationId, chunk), {
        excludeFromContext,
      }),
      (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    );

    return execution
      .andThen((result) => {
        const flushed = this.liveHistory?.flushPersisted();
        if (flushed?.isErr()) return err({ message: flushed.error.message });
        this.finishShellOperation(operationId, result.cancelled ? "aborted" : "completed");
        return ok(undefined);
      })
      .mapErr((error) => {
        this.finishShellOperation(operationId, "failed", error.message);
        return error;
      });
  }

  private startShellOperation(command: string, operationId: string): void {
    this.operationId = operationId;
    this.operationKind = "shell";
    this.activity = "busy";
    this.shellCommand = command;
    this.shellOutput = "";
    this.shellOutputTruncated = false;
    this.liveBlocks.clear();
    this.liveTools.clear();

    const blockId = `${operationId}-shell`;
    this.liveBlocks.set(blockId, { blockType: "shell", revision: 1, text: `$ ${command}` });
    this.broadcastEvent({ type: "operation_started", operationId });
    this.broadcastEvent({ type: "status", activity: "busy", operationId });
    this.broadcastEvent({
      type: "output_patch",
      operationId,
      blockId,
      blockType: "shell",
      revision: 1,
      patch: { type: "replace", text: `$ ${command}` },
    });
  }

  private appendShellOutput(operationId: string, chunk: string): void {
    if (this.operationId !== operationId || this.operationKind !== "shell") return;
    const previous = this.liveBlocks.get(`${operationId}-shell`);
    this.shellOutput += chunk;
    if (this.shellOutput.length > LIVE_SHELL_OUTPUT_LIMIT) {
      this.shellOutput = this.shellOutput.slice(-LIVE_SHELL_OUTPUT_LIMIT);
      this.shellOutputTruncated = true;
    }
    const output = `${this.shellOutputTruncated ? LIVE_SHELL_TRUNCATION_MARKER : ""}${this.shellOutput}`;
    const text = `$ ${this.shellCommand}\n${output}`;
    const revision = (previous?.revision ?? 0) + 1;
    this.liveBlocks.set(`${operationId}-shell`, { blockType: "shell", revision, text });
    this.broadcastEvent({
      type: "output_patch",
      operationId,
      blockId: `${operationId}-shell`,
      blockType: "shell",
      revision,
      patch:
        previous !== undefined && text.startsWith(previous.text)
          ? { type: "append", text: text.slice(previous.text.length) }
          : { type: "replace", text },
    });
  }

  private finishShellOperation(
    operationId: string,
    outcome: "completed" | "aborted" | "failed",
    message?: string,
  ): void {
    if (this.operationId !== operationId || this.operationKind !== "shell") return;
    this.operationId = null;
    this.operationKind = null;
    this.activity = "idle";
    this.shellCommand = "";
    this.shellOutput = "";
    this.shellOutputTruncated = false;
    this.liveBlocks.clear();
    this.liveTools.clear();
    this.broadcastEvent({
      type: "operation_finished",
      operationId,
      outcome,
      ...(message !== undefined ? { message } : {}),
    });
    this.broadcastEvent({ type: "status", activity: "idle" });
  }

  abortOperation(): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready" }),
      );
    }
    if (this.operationKind === "shell") {
      return ResultAsync.fromPromise(
        Promise.resolve().then(() => session.abortBash()),
        (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      );
    }
    if (
      this.operationId !== null &&
      this.operationOutcome !== "aborted" &&
      this.subagentWork.busy
    ) {
      const saved = Result.fromThrowable(
        () =>
          this.sessionManager?.appendCustomMessageEntry(
            "pi-orb.subagents-cancelling",
            "Cancelling delegated work.",
            true,
            {
              operationId: this.operationId,
              children: this.subagentWork.active.map((run) => run.childId),
            },
          ),
        (error) => ({ message: String(error) }),
      )();
      if (saved.isErr()) this.subagentAdapterFailed(saved.error.message);
      this.liveHistory?.observe("entry_appended");
    }
    this.operationOutcome = "aborted";
    if (this.operationId !== null) {
      this.subagentWork.cancel(this.operationId);
      if (this.subagentWork.busy) this.publishSubagents();
    }
    const children = this.abortSubagents?.();
    // Abort acceptance must not hold the mutation executor while tools drain.
    // The operation remains busy until root readiness and child holds settle.
    void ResultAsync.fromThrowable(
      async () => {
        await session.abort();
      },
      (error) => ({
        message: error instanceof Error ? error.message : String(error),
      }),
    )()
      .map(() => this.maybeFinishAgentOperation())
      .mapErr((error) => {
        this.health = this.failed("agent_abort_failed", error.message, false);
        return error;
      });
    if (children?.isErr())
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() => err(children.error));
    return ResultAsync.fromSafePromise(Promise.resolve());
  }
}
