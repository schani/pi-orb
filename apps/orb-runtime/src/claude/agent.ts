import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type ModelInfo,
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentSettingsEvent,
  type CommittedDisplayDetail,
  type DeliverOrbMessageResponse,
  type JsonObject,
  type LiveDisplayDetail,
  type McpConfig,
  type MessageInputBlock,
  MessageInputBlockSchema,
  type OrbMessageSystem,
  OrbMessageSystemSchema,
  projectDisplayRecord,
  projectRecordDetail,
  projectRecordImage,
  type RuntimeAlertRequest,
  type RuntimeAlertResponse,
  type RuntimeEvent,
  type RuntimeHealth,
  reasoningHeadline,
  type ServerFrame,
  type SettingsAction,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { prepareCheckout } from "../domain/checkout.ts";
import { readLiveDisplayDetail } from "../domain/display-detail.ts";
import { configurePersistentHome } from "../domain/home.ts";
import type { DetailError, OrbAgent, SnapshotError } from "../domain/orb-agent.ts";
import type { AgentGateView } from "../domain/requests.ts";
import { configurePersistentRust } from "../domain/rust.ts";
import type { HarnessSnapshot, LiveOperationView } from "../domain/types.ts";
import type { HookEnvSource } from "../hooks/env-file.ts";
import { BootHookRunner } from "../hooks/runner.ts";
import { NodeHookSpawner } from "../hooks/spawner.ts";
import { fetchMcpCatalog } from "../mcp/boot.ts";
import { fetchPersonalInstructions } from "../personal-instructions/endpoint.ts";
import { fetchBootContext } from "../pi/boot-context.ts";
import { environmentPrompt } from "../pi/environment-prompt.ts";
import { readExecutionIdentity } from "../pi/execution-identity.ts";
import { FileIdleStopFence } from "../pi/idle-stop-fence.ts";
import { fetchProjectInstructions } from "../project-instructions/endpoint.ts";
import { fetchProjectSecretSnapshotAtBoot } from "../project-secrets/endpoint.ts";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { ClaudeActivity } from "./activity.ts";
import { claudeChildEnvironment, fetchClaudeSubscription, verifyClaudeAccount } from "./auth.ts";
import { validateClaudeAuthSettings } from "./auth-settings.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";
import { readClaudeRepositoryInstructions } from "./instructions.ts";
import { type ClaudeMcpRuntime, createClaudeMcp } from "./mcp.ts";
import { DEFAULT_CLAUDE_MODEL, findClaudeModel, latestClaudeModels } from "./models.ts";
import { findNativeClaudeTranscript } from "./native-path.ts";
import { qualifyClaudeRestart } from "./restore.ts";

const NativeStateSchema = Type.Object({
  id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
  timestamp: Type.String(),
  cwd: Type.String(),
  deliveries: Type.Record(
    Type.String(),
    Type.Object({
      uuid: Type.String(),
      operationId: Type.String(),
      messageIds: Type.Array(Type.String()),
      content: Type.Optional(Type.Array(MessageInputBlockSchema)),
      fingerprint: Type.String(),
      system: Type.Optional(OrbMessageSystemSchema),
      submitted: Type.Literal(true),
    }),
  ),
  model: Type.Optional(Type.String()),
  effort: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
  ),
  ownedChildren: Type.Optional(Type.Record(Type.String(), Type.String())),
  ownedTasks: Type.Optional(Type.Record(Type.String(), Type.String())),
  ownedBackgroundTasks: Type.Optional(Type.Record(Type.String(), Type.String())),
  pendingHandoffs: Type.Optional(Type.Record(Type.String(), Type.String())),
  guardLifetime: Type.Optional(Type.String()),
});

export interface ClaudeOrbAgentOptions {
  readonly orbId: string;
  readonly repositoryUrl: string;
  readonly workDir: string;
  readonly skillsDir: string | null;
  readonly broker: BrokerEnv | null;
  readonly previewHost?: string | null;
  readonly incarnation?: string;
  readonly testLaunchFailure?: boolean;
  readonly sdkFactory?: (
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ) => Result<ClaudeQueryProcess, { message: string }>;
}
export interface ClaudeQueryProcess {
  readonly query: ClaudeQuery;
  readonly exited: Promise<void>;
  readonly stdoutEnded: Promise<Result<void, { message: string }>>;
  /** Request graceful exit without ending the SDK's public output iterator. */
  readonly requestShutdown: () => Result<void, { message: string }>;
}
export type ClaudeQuery = Pick<
  Query,
  | "close"
  | "interrupt"
  | "supportedModels"
  | "accountInfo"
  | "setModel"
  | "applyFlagSettings"
  | typeof Symbol.asyncIterator
>;
interface Delivery {
  uuid: string;
  operationId: string;
  messageIds: string[];
  content?: MessageInputBlock[];
  fingerprint: string;
  system?: OrbMessageSystem;
  submitted: boolean;
}
export interface NativeState {
  id: string;
  timestamp: string;
  cwd: string;
  deliveries: Record<string, Delivery>;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  ownedChildren?: Record<string, string>;
  ownedTasks?: Record<string, string>;
  ownedBackgroundTasks?: Record<string, string>;
  pendingHandoffs?: Record<string, string>;
  guardLifetime?: string;
}
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;
  push(value: SDKUserMessage): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting !== null) waiting({ done: false, value });
    else this.values.push(value);
  }
  close(): void {
    this.ended = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = null;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** Native tools and native disk sessions; no model API loop or SessionStore mirroring. */
export class ClaudeOrbAgent implements OrbAgent {
  readonly runtimeInstanceId = randomUUID();
  private health: RuntimeHealth;
  private hooks: BootHookRunner | null = null;
  private readonly activity = new ClaudeActivity();
  private readonly listeners = new Set<(frame: ServerFrame) => void>();
  private state: NativeState | null = null;
  private history: ClaudeHistory | null = null;
  private sdk: ClaudeQuery | null = null;
  private queryReady = false;
  private input: InputQueue | null = null;
  private exited: Promise<void> = Promise.resolve();
  private consuming: Promise<void> = Promise.resolve();
  private stdoutEnded: Promise<Result<void, { message: string }>> = Promise.resolve(ok(undefined));
  private requestShutdown: (() => Result<void, { message: string }>) | null = null;
  private readonly hookCallbacks = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;
  private token = "";
  private generation = 0;
  private configDir = "";
  private checkoutCommit: string | null = null;
  private prompt = "";
  private plugins: NonNullable<Options["plugins"]> = [];
  private published = 0;
  private accepting = true;
  private configuring = false;
  private submissionEpoch = 0;
  private settings: AgentSettingsEvent | null = null;
  private nativeModels: ModelInfo[] = [];
  private outcome: "completed" | "aborted" | "failed" = "completed";
  private operationError: string | undefined;
  private readonly blocks = new Map<
    string,
    {
      blockId: string;
      blockType: "text" | "reasoning";
      contentIndex: number;
      revision: number;
      text: string;
      redacted?: boolean;
    }
  >();
  private readonly tools = new Map<
    string,
    { callId: string; name: string; revision: number; state: "running" | "completed" | "failed" }
  >();
  private readonly messageBlocks = new Map<string, string[]>();
  private readonly streamBlocks = new Map<number, string>();
  private readonly fence: FileIdleStopFence;
  private executionId: string | null = null;
  private mcpConfigs: readonly McpConfig[] = [];
  private projectSecrets: Readonly<Record<string, string>> = {};
  private mcp: ClaudeMcpRuntime | null = null;
  private readonly options: ClaudeOrbAgentOptions;
  constructor(options: ClaudeOrbAgentOptions) {
    this.options = options;
    this.fence = new FileIdleStopFence(options.workDir);
    this.health = this.initializing("booting");
  }
  private initializing(
    phase: Extract<RuntimeHealth, { status: "initializing" }>["phase"],
  ): RuntimeHealth {
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "initializing",
      phase,
    };
  }
  private fail(code: string, message: string, retryable = false): void {
    this.accepting = false;
    this.outcome = "failed";
    this.operationError = message;
    if (this.settings !== null) {
      this.settings = { ...this.settings, writable: false };
      this.event(this.settings);
    }
    this.health = {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "failed",
      error: { code, message, retryable },
    };
  }
  private emit(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
  private event(event: RuntimeEvent): void {
    this.emit({ v: 1, type: "runtime.event", at: new Date().toISOString(), event });
  }
  private statePath(): string {
    return join(this.options.workDir, "claude", "session.json");
  }
  private saveState(): Result<void, { message: string }> {
    return Result.fromThrowable(
      () => nativeHistoryFiles.commit(this.statePath(), JSON.stringify(this.state)),
      () => ({ message: "Cannot commit Claude session pointer/input journal." }),
    )();
  }
  private nativePath(): Result<string | null, { message: string }> {
    return findNativeClaudeTranscript(this.configDir, this.state?.id ?? "");
  }

  getHealth(): RuntimeHealth {
    if (this.health.status !== "ready")
      return {
        ...this.health,
        ...(this.hooks === null || this.health.status === "failed"
          ? {}
          : { hooks: this.hooks.report() }),
      };
    return {
      ...this.health,
      activity: this.activity.busy || this.hasOwnedWork() ? "busy" : "idle",
      ...(this.activity.operationId === null ? {} : { operationId: this.activity.operationId }),
      ...(this.hooks === null ? {} : { hooks: this.hooks.report() }),
    };
  }
  hookEnvSource(): HookEnvSource {
    return { hookEnv: () => this.hooks?.hookEnv() ?? null };
  }
  shutdownHooks(): void {
    this.accepting = false;
    this.hooks?.shutdown();
  }
  subscribe(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async boot(): Promise<void> {
    const broker = this.options.broker;
    if (broker === null) {
      this.fail("claude_auth_required", "Connect a Claude subscription before starting this orb.");
      return;
    }
    if (this.options.testLaunchFailure) {
      this.fail(
        "e2e_launch_failure",
        "test composition deliberately failed this compute incarnation",
      );
      return;
    }
    const identity = readExecutionIdentity(process.env);
    if (identity.isErr()) {
      this.fail("session_init_failed", identity.error.message);
      return;
    }
    this.executionId = identity.value;
    const home = configurePersistentHome(this.options.workDir);
    if (home.isErr()) {
      this.fail("home_init_failed", home.error.message);
      return;
    }
    configurePersistentRust(home.value, process.env);
    this.health = this.initializing("cloning");
    const checkout = await prepareCheckout(this.options.workDir, this.options.repositoryUrl);
    if (checkout.isErr()) {
      this.fail(checkout.error.code, checkout.error.message, checkout.error.retryable);
      return;
    }
    this.checkoutCommit = checkout.value;
    const cwd = join(this.options.workDir, "repo");
    this.hooks = new BootHookRunner({
      repoDir: cwd,
      home: home.value,
      workDir: this.options.workDir,
      incarnation: this.options.incarnation ?? "0",
      task: new NoSimulationTask(`claude-hooks-${this.options.orbId}`, false),
      spawner: new NodeHookSpawner(),
      environment: process.env,
      onSetupStart: () => {
        this.health = this.initializing("setup_running");
      },
    });
    await this.hooks.runSetup();
    this.health = this.initializing("checking_project_secrets");
    const secrets = await fetchProjectSecretSnapshotAtBoot(broker);
    if (secrets.isErr()) {
      this.fail("project_secrets_unavailable", secrets.error.message, secrets.error.retryable);
      return;
    }
    this.hooks.addManagedEnvironmentNames(Object.keys(secrets.value.values));
    Object.assign(process.env, secrets.value.values);
    const mcp = await fetchMcpCatalog(broker);
    if (mcp.isErr()) {
      this.fail("mcp_unavailable", mcp.error.message, true);
      return;
    }
    this.mcpConfigs = mcp.value.servers;
    this.projectSecrets = secrets.value.values;
    const personal = await fetchPersonalInstructions(broker);
    if (personal.isErr()) {
      this.fail(
        "personal_instructions_unavailable",
        personal.error.message,
        personal.error.retryable,
      );
      return;
    }
    const project = await fetchProjectInstructions(broker);
    if (project.isErr()) {
      this.fail("project_instructions_unavailable", project.error.message, project.error.retryable);
      return;
    }
    const context = await fetchBootContext(broker);
    if (context.isErr()) {
      this.fail("boot_context_unavailable", context.error.message, context.error.retryable);
      return;
    }
    this.health = this.initializing("checking_auth");
    const auth = await fetchClaudeSubscription(broker);
    if (auth.isErr()) {
      this.fail(auth.error.code, auth.error.message, auth.error.retryable);
      return;
    }
    this.token = auth.value.token;
    this.generation = auth.value.generation;
    await this.hooks.runResume();
    await this.hooks.applyHookEnv(process.env);
    this.prompt = [
      environmentPrompt,
      personal.value.content,
      project.value.content,
      ...(this.options.previewHost ? [portExposurePrompt(this.options.previewHost)] : []),
      ...(context.value.userTimeZone ? [`User's time zone: ${context.value.userTimeZone}.`] : []),
    ]
      .filter(Boolean)
      .join("\n\n");
    this.health = this.initializing("loading_session");
    this.configDir = join(this.options.workDir, "claude", "config");
    const loaded = Result.fromThrowable(
      () => {
        mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
        const saved = nativeHistoryFiles.read(this.statePath());
        const value: unknown =
          saved === null
            ? { id: randomUUID(), timestamp: new Date().toISOString(), cwd, deliveries: {} }
            : JSON.parse(saved);
        this.state = Check(NativeStateSchema, value) ? value : null;
        if (this.options.skillsDir !== null) {
          const plugin = join(this.options.workDir, "claude", "platform-plugin");
          mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
          nativeHistoryFiles.commit(
            join(plugin, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: "pi-orb" }),
          );
          if (!existsSync(join(plugin, "skills")))
            symlinkSync(this.options.skillsDir, join(plugin, "skills"), "dir");
          this.plugins = [{ type: "local", path: plugin }];
        }
      },
      () => ({ message: "Cannot load retained Claude session state." }),
    )();
    if (
      loaded.isErr() ||
      this.state === null ||
      this.state.cwd !== cwd ||
      !/^[a-f0-9-]{36}$/.test(this.state.id)
    ) {
      this.fail(
        "session_load_failed",
        "Cannot load retained Claude session; refusing replacement.",
      );
      return;
    }
    const saved = this.saveState();
    if (saved.isErr()) {
      this.fail("session_init_failed", saved.error.message);
      return;
    }
    this.history = new ClaudeHistory(
      join(this.options.workDir, "claude"),
      this.state.id,
      this.state.timestamp,
    );
    const restored = this.flushHistory();
    if (restored.isErr()) {
      this.fail("history_unavailable", restored.error.message);
      return;
    }
    const recovered = qualifyClaudeRestart(this.state, this.history.view, this.lifetime());
    if (recovered.isErr()) {
      this.fail(recovered.error.code, recovered.error.message);
      return;
    }
    for (const operationId of recovered.value.interruptedOperations) {
      const id = `claude.interrupted:${operationId}`;
      if (this.history.view.some((record) => record.id === id)) continue;
      const recorded = this.platformEvent(
        "claude.operation_interrupted",
        "Previous operation was interrupted. Send a message to continue.",
        { operationId, automaticReplay: false },
        id,
      );
      if (recorded.isErr()) {
        this.fail("claude_recovery_publication_failed", recorded.error.message);
        return;
      }
    }
    if (recovered.value.orphanedChildren.length > 0) {
      const recorded = this.platformEvent(
        "claude.children_interrupted",
        "Previous native background work ended with its compute.",
        {
          children: recovered.value.orphanedChildren,
          previousLifetime: this.state.guardLifetime ?? "",
          lifetime: this.lifetime(),
        },
      );
      if (recorded.isErr()) {
        this.fail("claude_recovery_publication_failed", recorded.error.message);
        return;
      }
      this.state.ownedChildren = {};
      this.state.ownedTasks = {};
      this.state.ownedBackgroundTasks = {};
      this.state.pendingHandoffs = {};
      const saved = this.saveState();
      if (saved.isErr()) {
        this.fail("claude_recovery_persistence_failed", saved.error.message);
        return;
      }
    }
    const fence = this.fence.read();
    if (fence.isErr()) {
      this.fail("session_load_failed", fence.error.message);
      return;
    }
    this.accepting = fence.value !== this.lifetime();
    const started = await this.attachSession(
      this.state,
      this.history,
      this.configDir,
      this.checkoutCommit,
    );
    if (started.isErr()) {
      if (this.health.status !== "failed")
        this.fail("claude_sdk_unavailable", started.error.message, true);
      return;
    }
    const recorded = this.platformEvent("claude.auth", "Claude subscription connected.", {
      generation: this.generation,
    });
    if (recorded.isErr()) this.fail("claude_auth_publication_failed", recorded.error.message);
  }
  /** Testable composition boundary around a retained native authority and supervised SDK. */
  attachSession(
    state: NativeState,
    history: ClaudeHistory,
    configDir: string,
    checkoutCommit: string | null,
  ): ResultAsync<void, { message: string }> {
    this.state = state;
    this.history = history;
    this.configDir = configDir;
    this.checkoutCommit = checkoutCommit;
    this.configuring = true;
    this.outcome = "completed";
    this.operationError = undefined;
    this.activity.claim(`claude-initialization:${this.runtimeInstanceId}`);
    this.activity.beginDrain();
    return this.startQuery()
      .andThen(() => ResultAsync.fromSafePromise(this.closeExtensions()))
      .andThen(() => {
        const finished = this.finishMetadata("attach");
        if (finished.isErr()) return err(finished.error);
        this.health = {
          v: 1,
          orbId: this.options.orbId,
          runtimeInstanceId: this.runtimeInstanceId,
          status: "ready",
          sessionId: state.id,
          checkoutCommit,
          activity: "idle",
        };
        return ok(undefined);
      })
      .map(() => this.releaseMetadata())
      .mapErr((error) => {
        this.configuring = false;
        return error;
      });
  }
  private finishMetadata(stage: "attach" | "settings"): Result<void, { message: string }> {
    const flushed = this.flushHistory();
    if (flushed.isErr()) this.fail("history_unavailable", flushed.error.message);
    if (this.health.status === "failed") return err({ message: this.health.error.message });
    if (this.outcome !== "completed" || this.hasOwnedWork()) {
      const reason = this.hasOwnedWork() ? "owned_work" : "root_work";
      const message =
        "Native work raced metadata shutdown; inspect the retained session before recovery.";
      this.fail("claude_metadata_uncertain", message);
      const recorded = this.platformEvent("claude.metadata_failed", message, {
        stage,
        reason,
        ...(this.activity.hookCount > 0 ? { pendingHooks: this.activity.hookCount } : {}),
      });
      if (recorded.isErr()) this.fail("claude_metadata_publication_failed", recorded.error.message);
      return err({ message });
    }
    return ok(undefined);
  }
  private releaseMetadata(): void {
    this.activity.processExited(true);
    this.configuring = false;
    if (this.settings !== null) {
      this.settings = { ...this.settings, writable: true };
      this.event(this.settings);
    }
  }
  private startQuery(): ResultAsync<void, { message: string }> {
    if (!this.accepting || this.health.status === "failed")
      return errAsync({ message: "Claude session is not accepting work." });
    if (this.sdk !== null)
      return this.queryReady && this.closing === null
        ? ResultAsync.fromSafePromise(Promise.resolve())
        : errAsync({ message: "Claude query initialization or shutdown is pending." });
    if (this.options.sdkFactory !== undefined) return this.createQuery();
    if (this.options.broker === null)
      return errAsync({ message: "Claude subscription broker is unavailable." });
    return fetchClaudeSubscription(this.options.broker)
      .mapErr((error) => {
        this.fail(error.code, error.message, error.retryable);
        return error;
      })
      .andThen((grant) => {
        this.token = grant.token;
        this.generation = grant.generation;
        return this.createQuery();
      });
  }
  private createQuery(): ResultAsync<void, { message: string }> {
    const progress = { stage: "preparation" };
    return this.initializeQuery(progress).orElse(() => {
      const code =
        this.health.status === "failed" ? this.health.error.code : "claude_initialization_failed";
      const message =
        "Claude SDK initialization failed; inspect the retained session before restarting.";
      this.fail(code, message);
      if (this.settings !== null) {
        this.settings = { ...this.settings, writable: false };
        this.event(this.settings);
      }
      const recorded = this.platformEvent("claude.initialization_failed", message, {
        stage: progress.stage,
        code,
      });
      if (recorded.isErr())
        this.fail("claude_initialization_publication_failed", recorded.error.message);
      return ResultAsync.fromSafePromise(this.closeExtensions()).andThen(() => err({ message }));
    });
  }
  private initializeQuery(progress: { stage: string }): ResultAsync<void, { message: string }> {
    this.queryReady = false;
    this.closing = null;
    const state = this.state;
    if (state === null)
      return errAsync({ message: "Native Claude session pointer is unavailable." });
    const repositoryInstructions = readClaudeRepositoryInstructions(state.cwd);
    if (repositoryInstructions.isErr()) return errAsync(repositoryInstructions.error);
    const nativePath = this.nativePath();
    if (nativePath.isErr()) return errAsync(nativePath.error);
    const authSettings = validateClaudeAuthSettings(state.cwd, this.configDir);
    if (authSettings.isErr()) {
      this.fail(authSettings.error.code, authSettings.error.message);
      return errAsync(authSettings.error);
    }
    if (this.options.broker !== null) {
      const mcp = createClaudeMcp({
        configs: this.mcpConfigs,
        secrets: this.projectSecrets,
        broker: this.options.broker,
        task: new NoSimulationTask(`claude-mcp-${this.options.orbId}`, false),
        onState: (state) => {
          const recorded = this.platformEvent(
            "claude.mcp",
            state.message ?? `MCP ${state.server}: ${state.state}`,
            {
              server: state.server,
              state: state.state,
              ...(state.diagnostic === undefined
                ? {}
                : {
                    code: state.diagnostic.code,
                    ...(state.diagnostic.httpStatus === undefined
                      ? {}
                      : { httpStatus: state.diagnostic.httpStatus }),
                  }),
            },
          );
          if (recorded.isErr()) this.fail("claude_mcp_publication_failed", recorded.error.message);
        },
      });
      if (mcp.isErr()) return errAsync(mcp.error);
      this.mcp = mcp.value;
    }
    const input = new InputQueue();
    this.input = input;
    let resolveExit: () => void = () => undefined;
    let resolveStdout: (result: Result<void, { message: string }>) => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const stdoutEnded = new Promise<Result<void, { message: string }>>((resolve) => {
      resolveStdout = resolve;
    });
    const options: Options = {
      ...(this.mcp === null ? {} : { mcpServers: this.mcp.mcpServers }),
      cwd: state.cwd,
      env: claudeChildEnvironment(process.env, this.token, this.configDir),
      ...(nativePath.value !== null ? { resume: state.id } : { sessionId: state.id }),
      model: state.model ?? DEFAULT_CLAUDE_MODEL,
      ...(state.effort === undefined ? {} : { effort: state.effort }),
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [this.prompt, repositoryInstructions.value].filter(Boolean).join("\n\n"),
      },
      settingSources: ["user", "project", "local"],
      skills: "all",
      plugins: this.plugins,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settings: {
        apiKeyHelper: "",
        env: {
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: "",
          CLAUDE_CODE_USE_BEDROCK: "",
          CLAUDE_CODE_USE_VERTEX: "",
          CLAUDE_CODE_USE_FOUNDRY: "",
        },
      },
      spawnClaudeCodeProcess: (spawnOptions) => {
        // SDK requires a synchronous spawner; Node spawn errors are consumed immediately here.
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.once("exit", resolveExit);
        child.once("error", () => {
          this.fail("claude_process_failed", "Claude subprocess could not start.", true);
          resolveExit();
          resolveStdout(err({ message: "Claude subprocess could not start." }));
        });
        child.stdout.once("end", () => resolveStdout(ok(undefined)));
        child.stdout.once("error", () =>
          resolveStdout(err({ message: "Claude stdout drain failed." })),
        );
        child.stdout.once("close", () => {
          if (!child.stdout.readableEnded)
            resolveStdout(err({ message: "Claude stdout closed without EOF." }));
        });
        child.stderr.on("data", () => undefined);
        return child;
      },
      hooks: {
        SubagentStart: [
          {
            hooks: [
              (input) => {
                const callback = (async () => {
                  if (!("agent_id" in input)) return {};
                  const id = String(input.agent_id);
                  this.activity.childAdmitted(id, "Native Claude agent");
                  if (this.state !== null) {
                    this.state.guardLifetime = this.lifetime();
                    this.state.ownedChildren = {
                      ...this.state.ownedChildren,
                      [id]: "Native Claude agent",
                    };
                  }
                  const saved = this.saveState();
                  if (saved.isErr()) {
                    this.fail("claude_child_guard_failed", saved.error.message);
                    return { continue: false, stopReason: saved.error.message };
                  }
                  this.publishChildren();
                  return {};
                })();
                this.hookCallbacks.add(callback);
                void callback.then(() => this.hookCallbacks.delete(callback));
                return callback;
              },
            ],
          },
        ],
        SubagentStop: [{ hooks: [async () => ({})] }],
      },
    };
    progress.stage = "spawn";
    const started =
      this.options.sdkFactory?.(input, options) ??
      Result.fromThrowable(
        () => ({
          query: query({ prompt: input, options }),
          exited,
          stdoutEnded,
          requestShutdown: () => ok(undefined),
        }),
        () => ({ message: "Cannot start native Claude SDK session." }),
      )();
    if (started.isErr()) return errAsync(started.error);
    const sdk = started.value.query;
    this.sdk = sdk;
    this.exited = started.value.exited;
    this.stdoutEnded = started.value.stdoutEnded;
    this.requestShutdown = started.value.requestShutdown;
    this.consuming = this.consume(sdk);
    return ResultAsync.fromThrowable(
      async () => {
        progress.stage = "account";
        const verified = verifyClaudeAccount(await sdk.accountInfo());
        if (verified.isErr()) {
          this.fail(verified.error.code, verified.error.message);
          return err(verified.error);
        }
        progress.stage = "models";
        const models = await sdk.supportedModels();
        this.nativeModels = models;
        const selected = this.state?.model ?? DEFAULT_CLAUDE_MODEL;
        if (this.state !== null) {
          progress.stage = "model";
          const available = findClaudeModel(models, selected);
          if (available === undefined)
            return err({ message: `Selected Claude model is unavailable: ${selected}.` });
          progress.stage = "effort";
          const advertised = available.supportedEffortLevels ?? [];
          const effort =
            advertised.length === 0
              ? undefined
              : (this.state.effort ?? (advertised.includes("high") ? "high" : advertised[0]));
          if (advertised.length > 0 && (effort === undefined || !advertised.includes(effort)))
            return err({
              message: "Selected Claude model has no qualified native effort setting.",
            });
          progress.stage = "set_model";
          await sdk.setModel(selected);
          progress.stage = "flags";
          if (effort !== undefined) await sdk.applyFlagSettings({ effortLevel: effort });
          this.state.model = selected;
          if (effort === undefined) delete this.state.effort;
          else this.state.effort = effort;
          progress.stage = "persistence";
          const saved = this.saveState();
          if (saved.isErr()) return err(saved.error);
          this.settings = {
            type: "agent_settings",
            settings: {
              model: { provider: "claude", id: selected },
              thinkingLevel: this.state.effort ?? "off",
            },
            models: latestClaudeModels(models),
            writable: !this.configuring,
          };
          this.event(this.settings);
        }
        this.queryReady = true;
        return ok(undefined);
      },
      () => ({ message: "Claude SDK initialization failed." }),
    )().andThen((result) => result);
  }
  /** Supervision seam: resolves only after all SDK stdout has been consumed. */
  waitForStream(): Promise<void> {
    return this.consuming;
  }
  private async consume(sdk: ClaudeQuery): Promise<void> {
    const result = await ResultAsync.fromThrowable(
      async () => {
        for await (const message of sdk) this.onMessage(message);
      },
      () => ({ message: "Claude SDK stream failed; retained native state requires inspection." }),
    )();
    if (result.isErr()) {
      this.outcome = "failed";
      this.operationError = result.error.message;
      this.fail("claude_stream_failed", result.error.message, true);
    } else if (this.closing === null) {
      this.fail(
        "claude_stream_ended",
        "Claude exited unexpectedly; the retained session requires inspection.",
        true,
      );
    }
  }
  private onMessage(message: SDKMessage): void {
    if (
      this.closing !== null &&
      ((message.type === "system" &&
        message.subtype === "status" &&
        message.status === "requesting") ||
        (message.type === "assistant" && message.parent_tool_use_id === null))
    ) {
      this.outcome = "failed";
      this.operationError = "Native work started during query rotation; the session was stopped.";
    }
    if (message.type === "system") {
      if (message.subtype === "background_tasks_changed")
        this.activity.replaceTasks(
          message.tasks.map((task) => ({
            id: task.task_id,
            description: task.description,
            ambient: task.ambient === true,
          })),
        );
      if (message.subtype === "task_started")
        this.activity.taskStart(message.task_id, message.description, message.ambient === true);
      if (message.subtype === "task_notification") {
        if (this.outcome !== "aborted" && this.activity.hasTask(message.task_id)) {
          this.activity.taskHandoff(message.task_id, "Awaiting native result handoff");
          if (this.state !== null)
            this.state.pendingHandoffs = {
              ...this.state.pendingHandoffs,
              [message.task_id]: "Awaiting native result handoff",
            };
        }
        this.activity.taskEnd(message.task_id);
        this.activity.childTerminal(message.task_id);
        if (this.state !== null) {
          delete this.state.ownedChildren?.[message.task_id];
          delete this.state.ownedTasks?.[message.task_id];
        }
      }
      if (
        this.state !== null &&
        (message.subtype === "task_notification" ||
          message.subtype === "task_started" ||
          message.subtype === "background_tasks_changed")
      ) {
        if (message.subtype === "task_started" && message.ambient !== true)
          this.state.ownedTasks = {
            ...this.state.ownedTasks,
            [message.task_id]: message.description,
          };
        if (message.subtype === "background_tasks_changed")
          this.state.ownedBackgroundTasks = Object.fromEntries(
            message.tasks
              .filter((task) => task.ambient !== true)
              .map((task) => [task.task_id, task.description]),
          );
        this.state.guardLifetime = this.lifetime();
        const saved = this.saveState();
        if (saved.isErr()) this.fail("claude_child_guard_failed", saved.error.message);
      }
      if (message.subtype === "hook_started") this.activity.hookStart(message.hook_id);
      if (message.subtype === "hook_response") this.activity.hookEnd(message.hook_id);
      if (message.subtype === "status" && message.status !== null) this.activity.rootStarted();
      this.publishChildren();
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      this.activity.rootStarted();
      this.messageBlocks.set(message.uuid, [...this.streamBlocks.values()]);
      this.streamBlocks.clear();
      for (const block of message.message.content)
        if (block.type === "tool_use") {
          const tool = {
            callId: block.id,
            name: block.name,
            revision: 1,
            state: "running" as const,
          };
          this.tools.set(block.id, tool);
          if (this.activity.operationId !== null)
            this.event({ type: "tool_state", operationId: this.activity.operationId, ...tool });
        }
    }
    if (
      message.type === "user" &&
      message.parent_tool_use_id === null &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content)
        if (block.type === "tool_result") {
          const previous = this.tools.get(block.tool_use_id);
          if (previous !== undefined) {
            const tool = {
              ...previous,
              revision: previous.revision + 1,
              state: block.is_error ? ("failed" as const) : ("completed" as const),
            };
            this.tools.set(tool.callId, tool);
            if (this.activity.operationId !== null)
              this.event({ type: "tool_state", operationId: this.activity.operationId, ...tool });
          }
        }
    }
    if (
      message.type === "stream_event" &&
      message.parent_tool_use_id === null &&
      this.activity.operationId !== null
    ) {
      const event = message.event;
      const operationId = this.activity.operationId;
      const publish = (
        block: NonNullable<ReturnType<typeof this.blocks.get>>,
        previous?: typeof block,
      ) => {
        const reasoning = block.blockType === "reasoning";
        const headline = reasoning ? reasoningHeadline(block.text, block.redacted) : "";
        const reasoningVisible = reasoning && (block.redacted === true || block.text.trim() !== "");
        if (
          reasoning &&
          previous !== undefined &&
          reasoningHeadline(previous.text, previous.redacted) === headline &&
          (previous.redacted === true || previous.text.trim() !== "") === reasoningVisible
        )
          return;
        this.event({
          type: "output_patch",
          operationId,
          blockId: block.blockId,
          blockType: block.blockType,
          contentIndex: block.contentIndex,
          revision: block.revision,
          ...(reasoning ? { headline, reasoningVisible } : {}),
          patch: reasoning
            ? { type: "replace", text: "" }
            : previous === undefined
              ? { type: "replace", text: block.text }
              : { type: "append", text: block.text.slice(previous.text.length) },
        });
      };
      if (event.type === "message_start") this.streamBlocks.clear();
      if (
        event.type === "content_block_start" &&
        (event.content_block.type === "text" ||
          event.content_block.type === "thinking" ||
          event.content_block.type === "redacted_thinking")
      ) {
        const blockId = `${message.uuid}:${event.index}`;
        const block = {
          blockId,
          blockType:
            event.content_block.type === "text" ? ("text" as const) : ("reasoning" as const),
          contentIndex: event.index,
          revision: 0,
          text:
            event.content_block.type === "text"
              ? event.content_block.text
              : event.content_block.type === "thinking"
                ? event.content_block.thinking
                : "",
          ...(event.content_block.type === "redacted_thinking" ? { redacted: true } : {}),
        };
        this.blocks.set(blockId, block);
        this.streamBlocks.set(event.index, blockId);
        publish(block);
      }
      if (
        event.type === "content_block_delta" &&
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta")
      ) {
        const block = this.blocks.get(this.streamBlocks.get(event.index) ?? "");
        if (block !== undefined) {
          const previous = { ...block };
          const text = event.delta.type === "text_delta" ? event.delta.text : event.delta.thinking;
          block.text += text;
          block.revision++;
          publish(block, previous);
        }
      }
    }
    if (message.type === "result") {
      this.activity.rootFinished();
      if (this.state !== null) {
        this.state.pendingHandoffs = {};
        const saved = this.saveState();
        if (saved.isErr()) this.fail("claude_handoff_guard_failed", saved.error.message);
      }
      if (message.is_error) {
        this.outcome = "failed";
        this.operationError = "Claude turn failed.";
      }
    }
    const flushed = this.flushHistory();
    if (flushed.isErr()) {
      this.fail("history_unavailable", flushed.error.message);
      return;
    }
    if (this.activity.canDrain && this.closing === null) void this.drainOperation();
  }
  private publishChildren(): void {
    if (this.activity.operationId !== null)
      this.event({
        type: "subagents",
        operationId: this.activity.operationId,
        children: this.activity.children,
      });
  }
  private hasOwnedWork(): boolean {
    return (
      this.activity.children.length > 0 ||
      this.activity.hookCount > 0 ||
      Object.keys(this.state?.ownedChildren ?? {}).length > 0 ||
      Object.keys(this.state?.ownedTasks ?? {}).length > 0 ||
      Object.keys(this.state?.ownedBackgroundTasks ?? {}).length > 0 ||
      Object.keys(this.state?.pendingHandoffs ?? {}).length > 0
    );
  }
  private async drainOperation(): Promise<void> {
    const operationId = this.activity.operationId;
    if (operationId === null) return;
    this.activity.beginDrain();
    await this.closeExtensions();
    const flushed = this.flushHistory();
    if (flushed.isErr()) {
      this.fail("history_unavailable", flushed.error.message);
      return;
    }
    if (
      this.operationError ===
        "Native work started during query rotation; the session was stopped." &&
      this.health.status !== "failed"
    ) {
      const message =
        "Native root work raced query shutdown; inspect the retained session before recovery.";
      this.fail("claude_rotation_uncertain", message);
      const recorded = this.platformEvent("claude.rotation_failed", message, {
        reason: "root_work",
      });
      if (recorded.isErr()) this.fail("claude_rotation_publication_failed", recorded.error.message);
    }
    if (this.health.status === "failed") return;
    if (this.blocks.size > 0 || this.published !== this.history?.view.length) {
      this.fail(
        "claude_stream_identity_gap",
        "Native history and streamed output could not be correlated; inspection is required.",
      );
      return;
    }
    if (this.hasOwnedWork()) {
      const message =
        "Native owned work raced query shutdown; inspect the retained session before recovery.";
      this.fail(
        this.activity.hookCount > 0
          ? "claude_hook_recovery_required"
          : "claude_child_recovery_required",
        message,
      );
      const recorded = this.platformEvent("claude.rotation_failed", message, {
        reason: "owned_work",
        ...(this.activity.hookCount > 0 ? { pendingHooks: this.activity.hookCount } : {}),
      });
      if (recorded.isErr()) this.fail("claude_rotation_publication_failed", recorded.error.message);
      return;
    }
    const unsettled = Object.values(this.state?.deliveries ?? {}).some(
      (delivery) =>
        delivery.operationId === operationId &&
        delivery.submitted &&
        !this.history?.view.some((record) => record.id === delivery.uuid),
    );
    if (unsettled) {
      this.fail(
        "claude_delivery_uncertain",
        "Claude exited without a durable native input receipt; the accepted message requires inspection.",
      );
      return;
    }
    if (this.activity.operationId !== operationId) return;
    const terminal = this.platformEvent(
      "claude.operation_finished",
      this.operationError ?? `Claude operation ${this.outcome}.`,
      { operationId, outcome: this.outcome },
      `claude.operation:${operationId}`,
      this.outcome === "failed",
    );
    if (terminal.isErr()) {
      this.fail("claude_terminal_persistence_failed", terminal.error.message);
      return;
    }
    this.activity.processExited(true);
    this.blocks.clear();
    this.tools.clear();
    this.event({
      type: "operation_finished",
      operationId,
      outcome: this.outcome,
      ...(this.operationError === undefined ? {} : { message: this.operationError }),
    });
    this.event({ type: "status", activity: "idle" });
  }
  closeExtensions(): Promise<void> {
    this.queryReady = false;
    if (this.closing !== null) return this.closing;
    const sdk = this.sdk;
    // Start on the next microtask so every native edge sees the closing guard first.
    this.closing = Promise.resolve().then(async () => {
      this.input?.close();
      const requested = this.requestShutdown?.();
      if (requested?.isErr()) this.cleanupFailed("claude_shutdown_failed");
      await this.exited;
      const stdout = await this.stdoutEnded;
      if (stdout.isErr()) this.cleanupFailed("claude_stdout_drain_failed");
      await this.consuming;
      await Promise.all([...this.hookCallbacks]);
      const flushed = this.flushHistory();
      if (flushed.isErr()) this.fail("history_unavailable", flushed.error.message);
      const closed = Result.fromThrowable(
        () => sdk?.close(),
        () => ({ message: "Cannot close Claude SDK after native drain." }),
      )();
      if (closed.isErr()) this.cleanupFailed("claude_shutdown_failed");
      const mcpClosed = await this.mcp?.close();
      if (mcpClosed?.isErr()) this.cleanupFailed("claude_mcp_cleanup_failed");
      if (mcpClosed?.isErr() !== true) this.mcp = null;
      if (
        this.health.status !== "failed" &&
        stdout.isOk() &&
        requested?.isErr() !== true &&
        closed.isOk()
      ) {
        this.sdk = null;
        this.input = null;
        this.requestShutdown = null;
      }
    });
    return this.closing;
  }
  private cleanupFailed(code: string): void {
    const message = "Claude cleanup failed; inspect the retained session before recovery.";
    this.fail(code, message);
    const recorded = this.platformEvent("claude.cleanup_failed", message, { code });
    if (recorded.isErr()) this.fail("claude_cleanup_publication_failed", recorded.error.message);
  }
  private flushHistory(): Result<void, { message: string }> {
    if (this.history === null) return ok(undefined);
    const nativePath = this.nativePath();
    if (nativePath.isErr()) return err(nativePath.error);
    const scanned = this.history.scan(nativePath.value);
    if (scanned.isErr()) return err(scanned.error);
    const assistantUuids = new Set(
      scanned.value
        .filter((record) => record.type === "message" && record.role === "assistant")
        .map((record) => record.id),
    );
    let compacted = false;
    for (const delivery of Object.values(this.state?.deliveries ?? {})) {
      if (
        delivery.content === undefined ||
        !scanned.value.some((record) => record.id === delivery.uuid)
      )
        continue;
      delete delivery.content;
      delete delivery.system;
      compacted = true;
    }
    if (compacted) {
      const saved = this.saveState();
      if (saved.isErr()) return err(saved.error);
    }

    for (const record of scanned.value.slice(0, this.published)) {
      const retiredBlockIds = this.messageBlocks.get(record.id);
      if (retiredBlockIds === undefined || retiredBlockIds.length === 0) continue;
      this.messageBlocks.delete(record.id);
      for (const id of retiredBlockIds) this.blocks.delete(id);
      this.emit({
        v: 1,
        type: "history.record",
        at: new Date().toISOString(),
        record: projectDisplayRecord(record),
        retiredBlockIds,
        headId: scanned.value[this.published - 1]?.id ?? null,
      });
    }
    for (const record of scanned.value.slice(this.published)) {
      if (
        record.type === "message" &&
        record.role === "assistant" &&
        this.blocks.size > 0 &&
        !this.messageBlocks.has(record.id) &&
        ![...this.blocks.keys()].every((blockId) =>
          [...this.messageBlocks].some(
            ([uuid, blockIds]) => blockIds.includes(blockId) && assistantUuids.has(uuid),
          ),
        )
      )
        break;
      const retiredBlockIds = this.messageBlocks.get(record.id) ?? [];
      this.messageBlocks.delete(record.id);
      for (const id of retiredBlockIds) this.blocks.delete(id);
      this.emit({
        v: 1,
        type: "history.record",
        at: new Date().toISOString(),
        record: projectDisplayRecord(record),
        retiredBlockIds,
        headId: record.id,
      });
      this.published++;
    }
    return ok(undefined);
  }
  snapshot(): Result<HarnessSnapshot, SnapshotError> {
    if (this.health.status !== "ready" || this.state === null || this.history === null)
      return err({ type: "snapshot_error", message: "Claude session is not ready." });
    const flushed = this.flushHistory();
    if (flushed.isErr()) return err({ type: "snapshot_error", message: flushed.error.message });
    return ok({
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      activity: this.activity.busy || this.hasOwnedWork() ? "busy" : "idle",
      session: {
        id: this.state.id,
        timestamp: this.state.timestamp,
        overflow: { native: { id: this.state.id, cwd: this.state.cwd, harness: "claude" } },
      },
      records: this.history.view.slice(0, this.published),
      headId: this.history.view[this.published - 1]?.id ?? null,
      settings: this.settings,
    });
  }
  replicationSnapshot(): Result<HarnessSnapshot, SnapshotError> {
    return this.snapshot();
  }
  sessionId(): string | null {
    return this.state?.id ?? null;
  }
  gateView(): AgentGateView {
    return {
      acceptingWork: this.accepting && this.health.status === "ready",
      activity: this.activity.busy || this.hasOwnedWork() ? "busy" : "idle",
      headId: this.history?.view[this.published - 1]?.id ?? null,
      activeOperationId: this.activity.operationId,
      configuring: this.configuring,
    };
  }
  liveView(): LiveOperationView | null {
    return this.activity.operationId === null
      ? null
      : {
          operationId: this.activity.operationId,
          blocks: [...this.blocks.values()],
          tools: [...this.tools.values()],
          subagents: this.activity.children,
        };
  }
  private lifetime(): string {
    return `claude:${this.options.incarnation ?? "0"}:${this.executionId ?? process.env.PI_ORB_SUPERVISOR_ID ?? "native"}`;
  }
  prepareIdleStop(): Result<boolean, { message: string }> {
    if (this.health.status !== "ready") return err({ message: "Claude session is not ready." });
    if (this.activity.busy || this.hasOwnedWork() || this.configuring) return ok(false);
    if (!this.accepting) return this.sdk === null ? this.flushHistory().map(() => true) : ok(false);
    this.accepting = false;
    const saved = this.fence.write(this.lifetime());
    if (saved.isErr()) {
      this.fail("claude_stop_fence_failed", saved.error.message);
      return err(saved.error);
    }
    if (this.sdk !== null) {
      void this.closeExtensions();
      return ok(false);
    }
    return this.flushHistory().map(() => true);
  }
  submitMessage(
    content: readonly MessageInputBlock[],
    operationId: string,
  ): ResultAsync<void, { message: string }> {
    return this.submit(content, operationId, [], undefined);
  }
  private deliveryFingerprint(
    content: readonly MessageInputBlock[],
    messageIds: readonly string[],
    system?: OrbMessageSystem,
  ): string {
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, value]) => [key, canonical(value)]),
            )
          : value;
    return createHash("sha256")
      .update(JSON.stringify(canonical({ content, messageIds, system: system ?? null })))
      .digest("hex");
  }
  private submit(
    content: readonly MessageInputBlock[],
    operationId: string,
    messageIds: readonly string[],
    system: OrbMessageSystem | undefined,
  ): ResultAsync<void, { message: string }> {
    if (
      !this.accepting ||
      this.health.status !== "ready" ||
      this.state === null ||
      this.history === null ||
      this.hasOwnedWork() ||
      this.configuring ||
      !this.activity.claim(operationId)
    )
      return errAsync({ message: "Claude session is not accepting work." });
    const epoch = ++this.submissionEpoch;
    this.outcome = "completed";
    this.operationError = undefined;
    this.closing = null;
    this.event({ type: "operation_started", operationId });
    this.event({ type: "status", activity: "busy", operationId });
    return this.startQuery()
      .andThen(() => {
        const state = this.state,
          history = this.history,
          input = this.input;
        if (
          epoch !== this.submissionEpoch ||
          this.activity.operationId !== operationId ||
          !this.accepting ||
          this.health.status !== "ready" ||
          state === null ||
          history === null ||
          input === null ||
          this.sdk === null ||
          this.closing !== null
        )
          return err({ message: "Claude submission was cancelled before inference." });
        const uuid = randomUUID();
        const delivery: Delivery = {
          uuid,
          operationId,
          messageIds: [...messageIds],
          content: [...content],
          submitted: true,
          fingerprint: this.deliveryFingerprint(content, messageIds, system),
          ...(system === undefined ? {} : { system }),
        };
        const correlated = history.correlate(uuid, {
          messageIds,
          operationId,
          ...(system === undefined ? {} : { system: true }),
        });
        if (correlated.isErr()) {
          this.fail("claude_input_persistence_failed", correlated.error.message);
          return err(correlated.error);
        }
        state.deliveries[messageIds[0] ?? uuid] = delivery;
        const persisted = this.saveState();
        if (persisted.isErr()) {
          this.fail("claude_input_persistence_failed", persisted.error.message);
          return err(persisted.error);
        }
        input.push({
          type: "user",
          uuid,
          session_id: state.id,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: content.map((block) =>
              block.type === "text"
                ? { type: "text" as const, text: block.text }
                : {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: block.mediaType as
                        | "image/png"
                        | "image/jpeg"
                        | "image/gif"
                        | "image/webp",
                      data: block.data,
                    },
                  },
            ),
          },
        });
        return ok(undefined);
      })
      .mapErr((error) => {
        if (this.outcome !== "aborted") this.outcome = "failed";
        this.operationError = error.message;
        this.activity.rootFinished();
        void this.drainOperation();
        return error;
      });
  }
  deliverInboxMessage(
    messageId: string,
    messageIds: readonly string[],
    content: readonly MessageInputBlock[],
    system?: OrbMessageSystem,
  ): ResultAsync<DeliverOrbMessageResponse, { message: string; retryable: boolean }> {
    const existing = this.state?.deliveries[messageId];
    if (existing !== undefined) {
      if (
        JSON.stringify(existing.messageIds) !== JSON.stringify(messageIds) ||
        existing.fingerprint !== this.deliveryFingerprint(content, messageIds, system)
      )
        return errAsync({
          message: "Claude inbox batch conflicts with durable acceptance.",
          retryable: false,
        });
      const flushed = this.flushHistory();
      if (flushed.isErr()) return errAsync({ ...flushed.error, retryable: true });
      return ResultAsync.fromSafePromise(
        Promise.resolve({
          v: 1 as const,
          messageId,
          status: this.history?.view.some((record) => record.id === existing.uuid)
            ? ("persisted" as const)
            : ("queued" as const),
          delivery: "turn" as const,
          operationId: existing.operationId,
          duplicate: true,
        }),
      );
    }
    const operationId = randomUUID();
    return this.submit(content, operationId, messageIds, system)
      .map(() => ({
        v: 1 as const,
        messageId,
        status: "queued" as const,
        delivery: "turn" as const,
        operationId,
        duplicate: false,
      }))
      .mapErr((error) => ({ ...error, retryable: true }));
  }
  abortOperation(): ResultAsync<void, { message: string }> {
    this.submissionEpoch++;
    this.activity.cancel();
    this.outcome = "aborted";
    this.publishChildren();
    const sdk = this.sdk;
    if (sdk === null) return ResultAsync.fromSafePromise(Promise.resolve());
    return ResultAsync.fromThrowable(
      async () => {
        await sdk.interrupt();
        this.activity.rootFinished();
        await this.drainOperation();
        return this.health.status === "failed"
          ? err({ message: this.health.error.message })
          : ok(undefined);
      },
      () => ({ message: "Claude interrupt failed; cleanup remains busy." }),
    )().andThen((result) => result);
  }
  triggerAutoName(_content: readonly MessageInputBlock[]): void {}
  changeSettings(
    action: SettingsAction,
  ): ResultAsync<
    void,
    { code: "busy" | "invalid_request" | "internal" | "unsupported"; message: string }
  > {
    if (!this.accepting || this.activity.busy || this.hasOwnedWork() || this.configuring)
      return errAsync({ code: "busy", message: "Wait for the current operation to finish." });
    if (this.state === null || this.settings === null)
      return errAsync({ code: "unsupported", message: "Claude settings are unavailable." });
    if (
      action.type === "set_model" &&
      (action.model.provider !== "claude" ||
        !this.settings.models.some((model) => model.id === action.model.id))
    )
      return errAsync({ code: "invalid_request", message: "Unknown Claude model." });
    if (
      action.type === "set_thinking" &&
      (action.thinkingLevel === "off" || action.thinkingLevel === "minimal")
    )
      return errAsync({
        code: "unsupported",
        message: "Claude accepts native effort levels only.",
      });
    if (
      action.type === "set_thinking" &&
      !findClaudeModel(
        this.nativeModels,
        this.state.model ?? DEFAULT_CLAUDE_MODEL,
      )?.supportedEffortLevels?.some((level) => level === action.thinkingLevel)
    )
      return errAsync({
        code: "invalid_request",
        message: "Selected Claude model did not advertise this effort level.",
      });
    this.configuring = true;
    this.outcome = "completed";
    this.operationError = undefined;
    this.activity.claim(`claude-settings:${this.runtimeInstanceId}`);
    this.activity.beginDrain();
    this.settings = { ...this.settings, writable: false };
    this.event(this.settings);
    return this.startQuery()
      .mapErr((error) => ({ code: "internal" as const, message: error.message }))
      .andThen(() =>
        ResultAsync.fromThrowable(
          async () => {
            if (action.type === "set_model") {
              const levels =
                findClaudeModel(this.nativeModels, action.model.id)?.supportedEffortLevels ?? [];
              const effort = levels.includes(this.state?.effort ?? "high")
                ? (this.state?.effort ?? "high")
                : levels[0];
              await this.sdk?.setModel(action.model.id);
              await this.sdk?.applyFlagSettings({ effortLevel: effort ?? null });
              if (this.state !== null) {
                this.state.model = action.model.id;
                if (effort === undefined) delete this.state.effort;
                else this.state.effort = effort;
              }
            } else {
              const effort = action.thinkingLevel as NonNullable<NativeState["effort"]>;
              await this.sdk?.applyFlagSettings({ effortLevel: effort });
              if (this.state !== null) this.state.effort = effort;
            }
            const saved = this.saveState();
            if (saved.isErr()) {
              this.fail("claude_settings_persistence_failed", saved.error.message);
              return err({ code: "internal" as const, message: saved.error.message });
            }
            if (this.settings !== null && this.state?.model !== undefined) {
              this.settings = {
                ...this.settings,
                settings: {
                  model: { provider: "claude", id: this.state.model },
                  thinkingLevel: this.state.effort ?? "off",
                },
              };
              this.event(this.settings);
            }
            await this.closeExtensions();
            const finished = this.finishMetadata("settings");
            if (finished.isErr())
              return err({ code: "internal" as const, message: finished.error.message });
            this.releaseMetadata();
            return ok(undefined);
          },
          () => {
            this.fail("claude_settings_failed", "Claude settings outcome is uncertain.");
            return { code: "internal" as const, message: "Claude settings outcome is uncertain." };
          },
        )().andThen((result) => result),
      )
      .orElse((error) => {
        if (this.health.status !== "failed")
          this.fail("claude_settings_failed", "Claude settings outcome is uncertain.");
        return ResultAsync.fromSafePromise(this.closeExtensions()).andThen(() => {
          this.configuring = false;
          if (this.settings !== null) {
            this.settings = { ...this.settings, writable: false };
            this.event(this.settings);
          }
          return err(error);
        });
      });
  }
  private platformEvent(
    eventType: string,
    message: string,
    overflow: JsonObject,
    id: string = randomUUID(),
    display = true,
  ): Result<void, { message: string }> {
    if (this.history === null) return err({ message: "Claude history unavailable." });
    return this.history
      .appendPlatform({
        id,
        parentId: this.history.view.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        type: "event",
        eventType,
        content: [{ type: "text", text: message }],
        custom: { customType: eventType, display },
        overflow,
      })
      .andThen(() => this.flushHistory());
  }
  appendAlert(
    request: RuntimeAlertRequest,
  ): Result<RuntimeAlertResponse, { code: "unavailable" | "conflict"; message: string }> {
    if (!this.accepting || this.health.status !== "ready")
      return err({ code: "unavailable", message: "Claude runtime is not accepting alerts." });
    const existing = this.history?.view.find(
      (record) => record.overflow.requestId === request.requestId,
    );
    if (existing !== undefined)
      return existing.overflow.message === request.message
        ? ok({ v: 1, id: existing.id, duplicate: true })
        : err({ code: "conflict", message: "Alert request id conflicts." });
    const id = randomUUID();
    return this.platformEvent(
      "pi-orb.alert",
      request.message,
      { requestId: request.requestId, message: request.message },
      id,
    )
      .map(() => ({ v: 1 as const, id, duplicate: false }))
      .mapErr((error) => ({ code: "unavailable" as const, message: error.message }));
  }
  readDisplayDetail(
    recordId: string,
    detailKey: string,
  ): Result<CommittedDisplayDetail, DetailError> {
    const record = this.history?.view.find((record) => record.id === recordId);
    const body = record === undefined ? null : projectRecordDetail(record, detailKey);
    return body === null
      ? err({ type: "detail_not_found", message: "Claude record detail does not exist." })
      : ok({
          v: 1,
          sessionId: this.sessionId() ?? "",
          recordId,
          detailKey,
          state: "committed",
          body,
        });
  }
  readDisplayImage(
    recordId: string,
    detailKey: string,
    imageIndex: number,
  ): Result<{ mediaType: string; data: Buffer }, DetailError> {
    const record = this.history?.view.find((record) => record.id === recordId);
    const image = record === undefined ? null : projectRecordImage(record, detailKey, imageIndex);
    return image === null
      ? err({ type: "detail_not_found", message: "Claude record image does not exist." })
      : ok({ mediaType: image.mediaType, data: Buffer.from(image.data, "base64") });
  }
  readLiveDisplayDetail(operationId: string, blockId: string): LiveDisplayDetail {
    return readLiveDisplayDetail(this.sessionId() ?? "", this.liveView(), operationId, blockId);
  }
}
