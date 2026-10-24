import { createHash, randomUUID } from "node:crypto";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  getSupportedThinkingLevels,
  type Models,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type AgentState,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Cursor,
  configure,
  DEFAULT_RESTART_LIMIT,
  defineDoc,
  type EntryRecord,
  type EnvTarget,
  type Extension,
  Harness,
  type LiveState,
  ProviderDoc,
  type Registry,
  type ReportInfo,
  type Storage,
  StorageRequestError,
  type TaskGraph,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  AgentSettings,
  AgentSettingsEvent,
  ClientAction,
  DeliverOrbMessageResponse,
  HistoryRecord,
  OrbMessageSystem,
  PersonalInstructions,
  PullHistoryResponse,
  RequestResultFrame,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeHooks,
  ServerFrame,
} from "@pi-orb/protocol";
import { createDisplayRecordProjector, reasoningHeadline } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import {
  instructionsAdoption,
  PERSONAL_INSTRUCTIONS_ADOPTION,
  PROJECT_INSTRUCTIONS_ADOPTION,
} from "../../../../orb-runtime/src/domain/instructions-adoption.ts";
import {
  codexModelDisplayName,
  eligibleCodexModels,
  PINNED_CODEX_MODEL_ID,
} from "../../../../orb-runtime/src/domain/model-select.ts";
import {
  buildTurnSummaryInput,
  type TurnSummarizer,
  TurnSummaryCoordinator,
} from "../../../../orb-runtime/src/domain/turn-summary.ts";
import type { AgentLiveView, AgentSessionFacade, AgentSnapshot } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { ModelCallTiming, ModelCallUse } from "../../domain/model-usage.ts";
import type { OrbAgentError } from "../../domain/orb-agent-operations.ts";
import type { DeliverMessageClientRequest } from "../../domain/ports.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { storageAuthorityError } from "../durable-pg/storage-boundary.ts";
import { durableError } from "./manager.ts";
import { fenceModels } from "./model-fence.ts";
import { meterModels } from "./model-usage.ts";
import { nativeInputContent } from "./native-input.ts";
import { NOTIFICATION_REQUEST_PREFIX, submitParentNotification } from "./notifications.ts";
import type { AgentStorageLease, InputAdmissionError } from "./persistence.ts";
import { activeSubagents, type PublicEntryReceipt, projectHistory } from "./projection.ts";
import { promptExtension } from "./prompt.ts";
import { startupRuntimeError } from "./startup.ts";

const context = BACKGROUND_CONTEXT;
type Receipt = {
  fingerprint: string;
  operationId: string;
  delivery: "turn" | "steer";
  submissionId?: number;
  messageIds: string[];
  system?: OrbMessageSystem;
};
const Identity = defineDoc<{
  sessionId: string;
  timestamp: number;
  instructionDigest: string;
  receipts: Record<string, Receipt>;
  settings: Record<string, string>;
  publicSettingsInitialized: boolean;
}>({
  kind: "orb.identity",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    sessionId: randomUUID(),
    timestamp: Date.now(),
    instructionDigest: "",
    receipts: {},
    settings: {},
    publicSettingsInitialized: false,
  }),
});

const InstructionAdoptions = defineDoc<Record<string, { revision: number; sha256: string }>>({
  kind: "orb.instruction-adoptions",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

function publicSettings(state: Readonly<AgentState>): AgentSettings | null {
  return state.model
    ? {
        model: { provider: state.model.provider, id: state.model.modelId },
        thinkingLevel: state.thinkingLevel ?? "off",
      }
    : null;
}

async function appendSettingsHistory(
  tx: Tx,
  conversationId: ConversationId,
  previous: AgentSettings | null,
  next: AgentSettings | null,
  timestamp: number,
): Promise<void> {
  if (!next) return;
  if (previous?.model.provider !== next.model.provider || previous?.model.id !== next.model.id)
    await tx.appendEntry(conversationId, {
      kind: "orb.model-change",
      data: { provider: next.model.provider, modelId: next.model.id, timestamp },
    });
  if (previous?.thinkingLevel !== next.thinkingLevel)
    await tx.appendEntry(conversationId, {
      kind: "orb.thinking-level-change",
      data: { thinkingLevel: next.thinkingLevel, timestamp },
    });
}

const AlertReceipts = defineDoc<Record<string, { message: string; entryId: number }>>({
  kind: "orb.alert-receipts",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export interface DurableAgentOptions {
  readonly orbId: string;
  readonly storage: Storage;
  readonly env: ExecutionEnv;
  readonly envFor?: (target: EnvTarget) => ExecutionEnv;
  readonly resume?: boolean;
  readonly checkAdmission?: () => ResultAsync<void, RuntimeClientError>;
  readonly checkInputAdmission?: (browser: boolean) => ResultAsync<void, InputAdmissionError>;
  /** Consulted before resuming unfinished work; an error leaves it suspended. */
  readonly admitRecovery?: () => ResultAsync<void, RuntimeClientError>;
  readonly beginDrain?: AgentStorageLease["beginDrain"];
  readonly openSignal?: AbortSignal;
  readonly ownershipSignal?: AbortSignal;
  readonly executionActive?: () => boolean;
  readonly checkExecutionReady?: (
    context: import("@earendil-works/chord").Context,
  ) => ResultAsync<void, RuntimeClientError>;
  readonly models: Models;
  /** Usage ledger tap; never awaited by the model call. */
  readonly recordModelCall?: (
    use: ModelCallUse,
    response: AssistantMessage,
    timing: ModelCallTiming,
  ) => void;
  readonly registry: Registry;
  readonly activateResources?: (appendAlert: DurableAgent["appendAlert"]) => () => void;
  readonly bindNativeConversation?: (
    resolve: Harness["conversation"],
    abortTask: Harness["abortTask"],
  ) => void;
  readonly modelTools?: readonly ToolRegistration[];
  /** Child-only tools; the root conversation removes it on open. */
  readonly childExtension?: Extension;
  readonly checkoutCommit: string | null;
  readonly hooks?: RuntimeHooks;
  readonly instructions: string;
  readonly instructionSnapshots?: {
    readonly personal: PersonalInstructions;
    readonly project: PersonalInstructions;
  };
  readonly initialSettings?: AgentSettings;
  readonly now?: () => number;
  readonly edge?: (
    code: string,
    facts: Readonly<Record<string, string | number | boolean>>,
  ) => ResultAsync<void, RuntimeClientError>;
  /** Optional derived-history durability barrier supplied by the application composition. */
  readonly commitHistory?: (snapshot: AgentSnapshot) => ResultAsync<void, RuntimeClientError>;
  readonly closeResources?: () => ResultAsync<void, RuntimeClientError>;
  readonly turnSummary?: {
    readonly task: SimulationTask;
    readonly summarizer: TurnSummarizer;
    readonly timeoutMs?: number;
  };
}

/** Central authority; all public mutations cross a typed adapter boundary. */
export class DurableAgent implements AgentSessionFacade {
  readonly runtimeInstanceId = randomUUID();
  private readonly listeners = new Set<(frame: ServerFrame) => void>();
  private readonly invalidationListeners = new Set<() => void>();
  private records: HistoryRecord[] = [];
  private entries: EntryRecord[] = [];
  private receipts: Record<string, Receipt> = {};
  private settingsReceipts: Record<string, string> = {};
  private turnStart = 0;
  private readonly summaryAbort = new AbortController();
  private readonly summaryCoordinator: TurnSummaryCoordinator | undefined;
  private pendingSummaries = 0;
  private summaryOutcomes: Promise<void> = Promise.resolve();
  private readonly inboxEntries = new Map<number, string>();
  private readonly notificationEntries = new Set<number>();
  private readonly liveBlocks = new Map<string, Set<string>>();
  private readonly retiredBlocks = new Map<string, string[]>();
  private session = { id: "", timestamp: "", overflow: {} };
  private settings: AgentSettingsEvent | null = null;
  private live: LiveState = {};
  private inboxCount = 0;
  private tasks: TaskGraph = { tasks: {} };
  private queuedInput: number | undefined;
  private operationId: string | null = null;
  private readonly operationKind = "agent";
  private closing = false;
  private revokeResources: (() => void) | undefined;
  private paused: boolean;
  private closeResult: ResultAsync<void, RuntimeClientError> | null = null;
  private operationOutcome: "completed" | "aborted" | "failed" = "completed";
  private failure: RuntimeClientError | null = null;
  private view!: AttachedReplicatedState<ConversationView>;
  private graph!: AttachedReplicatedState<TaskGraph>;
  private unsubscribeView = () => {};
  private unsubscribeGraph = () => {};
  private unsubscribeCommits = () => {};
  private mutations: Promise<void> = Promise.resolve();
  private projection: Promise<Result<void, RuntimeClientError>> = Promise.resolve(ok(undefined));
  private pendingProjection = 0;
  private revision = 0;
  private readonly options: DurableAgentOptions;
  private readonly harness: Harness;
  private readonly root: Conversation;
  private constructor(options: DurableAgentOptions, harness: Harness, root: Conversation) {
    this.options = options;
    this.paused = options.resume === false;
    this.harness = harness;
    this.root = root;
    const summary = options.turnSummary;
    if (summary)
      this.summaryCoordinator = new TurnSummaryCoordinator({
        task: summary.task,
        timeoutMs: summary.timeoutMs ?? 15_000,
        summarizer: {
          summarize: (input, { signal }) =>
            this.summaryAbort.signal.aborted
              ? errAsync({ type: "turn_summary_error", message: "summary cancelled" })
              : summary.summarizer.summarize(input, {
                  signal: AbortSignal.any([signal, this.summaryAbort.signal]),
                }),
        },
        onSummary: (operationId, text) => {
          if (this.summaryAbort.signal.aborted) {
            this.settleSummary("harness.summary_failed", {
              orbId: options.orbId,
              operationId,
              cancelled: true,
            });
            return;
          }
          this.emit({ type: "turn_notification", operationId, summary: text });
          this.settleSummary("harness.summary_completed", {
            orbId: options.orbId,
            operationId,
            chars: text.length,
          });
        },
        onError: (operationId, error) => {
          this.settleSummary("harness.summary_failed", {
            orbId: options.orbId,
            operationId,
            cancelled: this.summaryAbort.signal.aborted,
            reason: error.message === "summary queue is full" ? "queue_full" : "inference_failed",
          });
        },
      });
  }

  private settleSummary(
    code: string,
    facts: Readonly<Record<string, string | number | boolean>>,
  ): void {
    this.summaryOutcomes = this.summaryOutcomes.then(async () => {
      await ResultAsync.fromPromise(
        (async () => {
          await this.options.edge?.(code, facts);
        })(),
        () => durableError("summary outcome recording failed"),
      );
      this.pendingSummaries--;
    });
  }

  static open(options: DurableAgentOptions): ResultAsync<DurableAgent, RuntimeClientError> {
    let harness: Harness | undefined;
    let stage = "registry";
    let owner: DurableAgent | undefined;
    const reports: ReportInfo[] = [];
    let unexpectedClose = false;
    let resourceClose: ResultAsync<void, RuntimeClientError> | undefined;
    const closeResources = () =>
      (resourceClose ??= options.closeResources?.() ?? okAsync(undefined));
    // Bound by the identity commit, before scheduling can start a generation.
    let rootSessionId: string | undefined;
    const models = options.recordModelCall
      ? meterModels(
          options.models,
          () => rootSessionId,
          () => options.now?.() ?? Date.now(),
          options.recordModelCall,
        )
      : options.models;
    return ResultAsync.fromPromise(
      (async () => {
        options.registry.install(promptExtension(options.instructions));
        stage = "storage";
        harness = await Harness.open(
          options.storage,
          {
            models: options.checkAdmission
              ? fenceModels(models, options.checkAdmission, options.ownershipSignal)
              : models,
            registry: options.registry,
            settings: { steeringMode: "all", followUpMode: "all" },
            env: (target) => options.envFor?.(target) ?? options.env,
            ...(options.now === undefined ? {} : { now: options.now }),
            onReport: (error, info) => {
              if (unexpectedClose) {
                owner?.storageFailed(error);
                return;
              }
              if (owner) void owner.reportFailure(info);
              else reports.push(info);
            },
          },
          context,
        );
        options.bindNativeConversation?.(
          harness.conversation.bind(harness),
          harness.abortTask.bind(harness),
        );
        const initial = options.initialSettings ?? {
          model: { provider: "openai-codex", id: PINNED_CODEX_MODEL_ID },
          thinkingLevel: "high" as const,
        };
        stage = "root";
        const root = await harness.root(context, {
          agent: {
            cwd: options.env.cwd,
            model: { provider: initial.model.provider, modelId: initial.model.id },
            thinkingLevel: initial.thinkingLevel,
          },
        });
        stage = "identity";
        const priorIdentity = await options.storage.findDocument(
          { kind: "orb.identity", scope: { kind: "conversation", conversationId: root.id } },
          "current",
          context,
        );
        const identity = await root.commit(async (tx) => {
          const doc = await tx.doc(Identity, root.id);
          if (!priorIdentity) doc.sessionId = `conversation:${options.orbId}`;
          if (!doc.publicSettingsInitialized) {
            await appendSettingsHistory(
              tx,
              root.id,
              null,
              publicSettings(await tx.doc(AgentDoc, root.id)),
              options.now?.() ?? Date.now(),
            );
            doc.publicSettingsInitialized = true;
          }
          if (options.instructionSnapshots) {
            const adoptions = await tx.doc(InstructionAdoptions, root.id);
            for (const [customType, snapshot] of [
              [PERSONAL_INSTRUCTIONS_ADOPTION, options.instructionSnapshots.personal],
              [PROJECT_INSTRUCTIONS_ADOPTION, options.instructionSnapshots.project],
            ] as const) {
              const next = instructionsAdoption(snapshot, adoptions[customType] ?? null);
              if (!next) continue;
              await tx.appendEntry(root.id, {
                kind: "orb.instructions-adoption",
                data: { customType, data: next, timestamp: options.now?.() ?? Date.now() },
              });
              adoptions[customType] = next;
            }
          }
          doc.instructionDigest = createHash("sha256").update(options.instructions).digest("hex");
          // pi-durable creates the same document lazily before the first provider request.
          rootSessionId = (await tx.doc(ProviderDoc, root.id)).sessionId;
          return {
            sessionId: doc.sessionId,
            timestamp: doc.timestamp,
            receipts: JSON.parse(JSON.stringify(doc.receipts)) as Record<string, Receipt>,
            settings: JSON.parse(JSON.stringify(doc.settings ?? {})) as Record<string, string>,
          };
        }, context);
        await root.configure(
          {
            cwd: options.env.cwd,
            ...(options.modelTools ? { tools: null, modelTools: options.modelTools } : {}),
            ...(options.childExtension ? { extensions: { remove: [options.childExtension] } } : {}),
          },
          context,
        );
        const agent = new DurableAgent({ ...options, closeResources }, harness, root);
        owner = agent;
        for (const info of reports) await agent.reportFailure(info);
        agent.session = {
          id: identity.sessionId,
          timestamp: new Date(identity.timestamp).toISOString(),
          overflow: { harness: "pi-durable" },
        };
        agent.receipts = identity.receipts;
        agent.settingsReceipts = identity.settings;
        let unfinishedSubmissions = false;
        let submissionCursor: Cursor | undefined;
        do {
          const page = await options.storage.scanSubmissions(
            { conversationId: root.id },
            256,
            submissionCursor,
            context,
          );
          for (const submission of page.items) {
            if (submission.status === "queued" || submission.status === "placed")
              unfinishedSubmissions = true;
            if (submission.entry !== undefined && submission.requestId?.startsWith("inbox:"))
              agent.inboxEntries.set(submission.entry, submission.requestId.slice(6));
            if (
              submission.entry !== undefined &&
              submission.requestId?.startsWith(NOTIFICATION_REQUEST_PREFIX)
            )
              agent.notificationEntries.add(submission.entry);
          }
          submissionCursor = page.next;
        } while (submissionCursor !== undefined);
        let cursor: Cursor | undefined;
        do {
          const page = await root.entries({}, 256, cursor, context);
          agent.entries.unshift(...[...page.items].reverse());
          cursor = page.next;
        } while (cursor !== undefined);
        stage = "observations";
        agent.view = await root.viewState(context);
        agent.graph = await harness.taskGraph(context);
        agent.updateView(agent.view.value);
        agent.tasks = agent.graph.value;
        const inspection = await harness.inspect(context);
        for (const task of inspection.tasks) {
          if (
            task.state.kind === "blocked" &&
            task.state.reason === "restart_limit" &&
            !reports.some((info) => info.type === "task_parked" && info.task.id === task.record.id)
          ) {
            await agent.reportFailure({ type: "task_parked", task: task.record });
          }
        }
        agent.unsubscribeView = agent.view.subscribe((value) => agent.updateView(value));
        agent.unsubscribeGraph = agent.graph.subscribe((value) => {
          agent.tasks = value;
          agent.updateView(agent.view.value);
        });
        agent.unsubscribeCommits = harness.subscribeCommits((publication) => {
          let changed = false;
          for (const change of publication.changes) {
            if (change.type === "entry" && change.value.conversationId === root.id) {
              agent.entries.push(change.value);
              const entry = change.value;
              const owner =
                entry.model?.[0]?.role === "assistant" && entry.byTaskId !== undefined
                  ? String(entry.byTaskId)
                  : undefined;
              if (owner !== undefined) {
                agent.retiredBlocks.set(`${agent.session.id}:${entry.id}`, [
                  ...(agent.liveBlocks.get(owner) ?? []),
                ]);
                agent.liveBlocks.delete(owner);
              }
              changed = true;
            }
            if (
              change.type === "submission" &&
              change.value.conversationId === root.id &&
              change.value.entry !== undefined
            ) {
              if (change.value.requestId?.startsWith("inbox:"))
                agent.inboxEntries.set(change.value.entry, change.value.requestId.slice(6));
              if (change.value.requestId?.startsWith(NOTIFICATION_REQUEST_PREFIX)) {
                agent.notificationEntries.add(change.value.entry);
                changed = true;
              }
            }
          }
          if (changed) agent.queueProjection();
        });
        harness.subscribeClose(() => {
          if (!agent.closing) unexpectedClose = true;
        });
        void harness.closed.then((end) => {
          if (end.reason === "failed") agent.storageFailed(end.error);
        });
        const recoveredTasks = Object.keys(agent.tasks.tasks);
        const recovering = recoveredTasks.length > 0 || unfinishedSubmissions;
        if (recovering && options.resume !== false) {
          stage = "recovery budget";
          const admitted = await options.admitRecovery?.();
          if (admitted?.isErr()) {
            await agent.close();
            return err(admitted.error);
          }
          stage = "restart notice";
          await root.commit(
            (tx) =>
              tx.appendEntry(root.id, {
                kind: "orb.harness-restarted",
                data: { timestamp: agent.now(), taskIds: recoveredTasks },
              }),
            context,
          );
        }
        stage = "projection";
        const projected = await agent.queueProjection();
        if (projected.isErr()) {
          await agent.close();
          return err(projected.error);
        }
        const edge = await options.edge?.("harness.opened", {
          orbId: options.orbId,
          sessionId: identity.sessionId,
          recovered: recovering,
          readonly: agent.paused,
          processId: process.pid,
        });
        if (edge?.isErr()) {
          await agent.close();
          return err(edge.error);
        }
        const admitted = await options.checkAdmission?.();
        if (admitted?.isErr() || options.openSignal?.aborted) {
          await agent.close();
          return err(admitted?.isErr() ? admitted.error : durableError("agent open cancelled"));
        }
        agent.updateStatus();
        stage = "resume";
        if (options.resume !== false) {
          await root.submitMany([], context);
          agent.revokeResources = options.activateResources?.(agent.appendAlert.bind(agent));
          harness.resume();
        }
        return ok(agent);
      })(),
      (error) => {
        const terminal = storageAuthorityError(error);
        return terminal
          ? startupRuntimeError(terminal)
          : durableError(`central Harness initialization failed (${stage})`);
      },
    )
      .andThen((result) => result)
      .orElse((error) => {
        const cleanup = harness
          ? ResultAsync.fromPromise(harness.close(context), () =>
              durableError("failed Harness cleanup failed"),
            )
          : ResultAsync.fromPromise(options.storage.close(context), () =>
              durableError("failed storage cleanup failed"),
            );
        return ResultAsync.fromSafePromise(
          (async () => {
            await cleanup;
            await closeResources();
            await options.edge?.("harness.open_failed", { orbId: options.orbId, stage });
            return err<DurableAgent, RuntimeClientError>(error);
          })(),
        ).andThen((result) => result);
      });
  }

  private storageFailed(error: unknown): void {
    this.failStorage(storageAuthorityError(error));
  }

  private failStorage(authority?: AuthorityError): void {
    if (this.closing) return;
    this.failure = authority
      ? startupRuntimeError(authority)
      : durableError("Agent storage failed; reopen the conversation");
    this.operationOutcome = "failed";
    this.publish({
      v: 1,
      type: "server.error",
      at: new Date(this.now()).toISOString(),
      error: {
        code: "central_agent_storage_failed",
        message: this.failure.message,
        retryable: this.failure.retryable,
      },
    });
    void this.options.edge?.("harness.storage_failed", {
      orbId: this.options.orbId,
      code: authority?.code ?? "unavailable",
    });
    void this.close();
  }

  private parkingNotice(background: boolean): ServerFrame & { type: "server.error" } {
    return {
      v: 1,
      type: "server.error",
      at: new Date(this.now()).toISOString(),
      error: {
        code: "central_agent_paused",
        message: background
          ? "Background task paused after five consecutive interruptions without progress"
          : "Agent paused after five consecutive interruptions without progress; abort the interrupted turn to continue",
        retryable: false,
      },
    };
  }

  private reportFailure(info: ReportInfo): PromiseLike<void> {
    const parked = info.type === "task_parked";
    return ResultAsync.fromPromise(this.harness.inspect(context), () =>
      durableError("Harness inspection failed"),
    ).then((inspection) => {
      const task = "task" in info ? info.task : undefined;
      const tasks = inspection.isOk() ? inspection.value.tasks : [];
      const record = tasks.find((entry) => entry.record.id === task?.id)?.record;
      const blocksRoot = (record: (typeof tasks)[number]["record"]): boolean => {
        if (record.conversationId !== this.root.id) return false;
        let current: typeof record | undefined = record;
        while (current) {
          if (current.background) return false;
          const owner: typeof current.owner = current.owner;
          current =
            owner === undefined
              ? undefined
              : tasks.find((entry) => entry.record.id === owner)?.record;
        }
        return true;
      };
      const message = parked
        ? this.parkingNotice(record !== undefined && !blocksRoot(record)).error.message
        : "Agent extension reported a failure";
      this.publish({
        v: 1,
        type: "server.error",
        at: new Date(this.now()).toISOString(),
        error: {
          code: parked ? "central_agent_paused" : "central_agent_report",
          message,
          retryable: false,
        },
      });
      const facts = {
        orbId: this.options.orbId,
        type: info.type,
        ...(task ? { task: task.id, conversation: task.conversationId, kind: task.kind } : {}),
        ...("reason" in info ? { reason: info.reason } : {}),
        ...(parked || ("reason" in info && info.reason === "restart_limit")
          ? { restarts: record?.restarts ?? DEFAULT_RESTART_LIMIT, limit: DEFAULT_RESTART_LIMIT }
          : {}),
      };
      void this.options.edge?.("harness.reported_failure", facts);
      if (
        inspection.isErr() ||
        tasks.some(
          (entry) =>
            entry.state.kind === "blocked" &&
            entry.state.reason !== "restart_limit" &&
            blocksRoot(entry.record),
        )
      ) {
        this.failure = inspection.isErr()
          ? inspection.error
          : durableError(parked ? message : "Agent execution is blocked");
        this.operationOutcome = "failed";
      }
      if (parked || this.failure) void this.options.edge?.("harness.execution_blocked", facts);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private emit(event: RuntimeEvent): void {
    this.publish({ v: 1, type: "runtime.event", at: new Date(this.now()).toISOString(), event });
  }
  private publish(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
  subscribe(listener: (frame: ServerFrame) => void, onInvalidated?: () => void): () => void {
    if (this.closing) {
      onInvalidated?.();
      return () => undefined;
    }
    this.listeners.add(listener);
    if (onInvalidated) this.invalidationListeners.add(onInvalidated);
    return () => {
      this.listeners.delete(listener);
      if (onInvalidated) this.invalidationListeners.delete(onInvalidated);
    };
  }
  accepting(): boolean {
    return !this.closing;
  }
  revoke(): void {
    if (this.closing) return;
    this.closing = true;
    this.revokeResources?.();
    for (const listener of this.invalidationListeners) listener();
    this.invalidationListeners.clear();
    this.listeners.clear();
  }
  resume(): void {
    if (this.closing || this.options.resume === false) return;
    this.paused = false;
    this.harness.resume();
    this.updateStatus();
  }
  executionActive(): boolean {
    return this.options.executionActive?.() ?? false;
  }
  checkExecutionReady(
    ctx: import("@earendil-works/chord").Context,
  ): ResultAsync<void, RuntimeClientError> {
    return this.options.checkExecutionReady?.(ctx) ?? okAsync(undefined);
  }
  workActive(): boolean {
    return !this.paused && this.unfinishedWork();
  }
  private unfinishedWork(): boolean {
    return (
      this.inboxCount > 0 || Object.keys(this.tasks.tasks).length > 0 || this.live.run !== undefined
    );
  }
  private busy(): boolean {
    return this.unfinishedWork() || this.pendingProjection > 0;
  }

  private updateView(value: ConversationView): void {
    this.live = (value.docs["pi.live"] ?? {}) as LiveState;
    const inbox = value.docs["pi.inbox"] as { items?: { id: number; mode: string }[] } | undefined;
    this.inboxCount = inbox?.items?.length ?? 0;
    this.queuedInput = inbox?.items?.find((item) => item.mode !== "write")?.id;
    const agent = value.docs["pi.agent"] as
      | {
          model?: { provider: string; modelId: string };
          thinkingLevel?: AgentSettings["thinkingLevel"];
        }
      | undefined;
    if (agent?.model) {
      this.settings = {
        type: "agent_settings",
        settings: {
          model: { provider: agent.model.provider, id: agent.model.modelId },
          thinkingLevel: agent.thinkingLevel ?? "off",
        },
        models: eligibleCodexModels(this.options.models.getModels("openai-codex")).map((model) => ({
          provider: model.provider,
          id: model.id,
          name: codexModelDisplayName(model.id),
          thinkingLevels: getSupportedThinkingLevels(model),
        })),
        writable: !this.paused && !this.busy(),
      };
      this.emit(this.settings);
    }
    this.revision++;
    this.updateStatus();
    const view = this.liveView();
    if (view) {
      for (const block of view.blocks) {
        const owner = this.live.run?.taskId;
        if (owner !== undefined && owner !== null) {
          const ids = this.liveBlocks.get(String(owner)) ?? new Set<string>();
          ids.add(block.blockId);
          this.liveBlocks.set(String(owner), ids);
        }
        this.emit({
          type: "output_patch",
          operationId: view.operationId,
          blockId: block.blockId,
          blockType: block.blockType,
          revision: block.revision,
          ...(block.blockType === "reasoning" ? { headline: reasoningHeadline(block.text) } : {}),
          patch: { type: "replace", text: block.blockType === "reasoning" ? "" : block.text },
        });
      }
      for (const tool of view.tools)
        this.emit({ type: "tool_state", operationId: view.operationId, ...tool });
      this.emit({
        type: "subagents",
        operationId: view.operationId,
        children: [...view.subagents],
      });
    }
  }

  private updateStatus(): void {
    const active = !this.paused && this.busy();
    const run = this.live.run;
    const task = run?.taskId ?? Object.values(this.tasks.tasks).find((task) => task.background)?.id;
    const input = run ? run.inputs[0] : task === undefined ? this.queuedInput : undefined;
    const operation =
      input !== undefined
        ? `${this.session.id}:submission:${input}`
        : task !== undefined
          ? `${this.session.id}:task:${task}`
          : undefined;
    if (active && this.operationId === null && operation !== undefined) {
      this.operationId = operation;
      this.operationOutcome = "completed";
      this.turnStart = this.records.length;
      this.emit({ type: "operation_started", operationId: this.operationId });
    }
    // Native cancellation is committed on the current run even without an assistant terminal.
    if (this.operationId !== null && run && this.tasks.tasks[String(run.taskId)]?.abortRequested)
      this.operationOutcome = "aborted";
    if (!active && this.operationId !== null) {
      const turn = this.records.slice(this.turnStart);
      if (
        this.summaryCoordinator &&
        !this.closing &&
        !this.failure &&
        this.operationKind === "agent" &&
        this.operationOutcome === "completed" &&
        turn.some((record) => record.type === "message" && record.role === "assistant")
      ) {
        const input = buildTurnSummaryInput(turn);
        if (input) {
          void this.options.edge?.("harness.summary_queued", {
            orbId: this.options.orbId,
            operationId: this.operationId,
          });
          this.pendingSummaries++;
          this.summaryCoordinator.enqueue(this.operationId, input);
        }
      }
      this.emit({
        type: "operation_finished",
        operationId: this.operationId,
        outcome: this.failure ? "failed" : this.operationOutcome,
      });
      this.operationId = null;
    }
    if (this.settings && this.settings.writable !== (!this.paused && !active)) {
      this.settings = { ...this.settings, writable: !this.paused && !active };
      this.emit(this.settings);
    }
    this.emit({
      type: "status",
      activity: active ? "busy" : "idle",
      ...(this.operationId ? { operationId: this.operationId } : {}),
    });
  }

  private queueProjection(): Promise<Result<void, RuntimeClientError>> {
    const entries = [...this.entries];
    const notifications = new Set(this.notificationEntries);
    this.pendingProjection++;
    this.projection = this.projection
      .then(async (previous) => {
        if (previous.isErr()) return previous;
        const receipts = new Map<number, PublicEntryReceipt>();
        for (const [entryId, messageId] of this.inboxEntries) {
          const receipt = this.receipts[messageId];
          if (receipt) receipts.set(entryId, receipt);
        }
        const projected = projectHistory(entries, this.session.id, receipts, notifications);
        if (projected.isErr()) return err(durableError("central history mapping failed"));
        const records = [...projected.value];
        const snapshot: AgentSnapshot = {
          orbId: this.options.orbId,
          runtimeInstanceId: this.runtimeInstanceId,
          session: this.session,
          activity: !this.paused && this.busy() ? "busy" : "idle",
          records,
          headId: records.at(-1)?.id ?? null,
          settings: this.settings,
        };
        const persisted = await this.options.commitHistory?.(snapshot);
        if (persisted?.isErr()) return err(persisted.error);
        const project = createDisplayRecordProjector();
        const known = new Set(this.records.map((record) => record.id));
        this.records = records;
        for (const record of records) {
          const display = project(record);
          if (!known.has(record.id)) {
            if (
              record.type === "message" &&
              record.role === "assistant" &&
              this.operationOutcome !== "aborted"
            )
              this.operationOutcome =
                record.finishReason === "error"
                  ? "failed"
                  : record.finishReason === "aborted"
                    ? "aborted"
                    : "completed";
            this.publish({
              v: 1,
              type: "history.record",
              at: new Date(this.now()).toISOString(),
              record: display,
              retiredBlockIds: this.retiredBlocks.get(record.id) ?? [],
              headId: record.id,
            });
            this.retiredBlocks.delete(record.id);
          }
        }
        return ok(undefined);
      })
      .then(async (result) => {
        this.pendingProjection--;
        if (result.isErr() && this.failure === null) {
          this.failure = result.error;
          await this.options.edge?.("history.projection_failed", {
            orbId: this.options.orbId,
            sessionId: this.session.id,
          });
          this.publish({
            v: 1,
            type: "server.error",
            at: new Date(this.now()).toISOString(),
            error: {
              code: "history_unavailable",
              message: result.error.message,
              retryable: result.error.retryable,
            },
          });
        }
        this.updateStatus();
        const view = result.isOk() ? this.liveView() : null;
        if (view)
          this.emit({
            type: "subagents",
            operationId: view.operationId,
            children: [...view.subagents],
          });
        return result;
      });
    return this.projection;
  }

  snapshot(): Result<AgentSnapshot, { message: string }> {
    if (this.failure) return err({ message: this.failure.message });
    const parked = Object.values(this.tasks.tasks).find((task) => task.blocked === "restart_limit");
    return ok({
      ...(parked
        ? {
            notice: this.parkingNotice(parked.background || parked.conversationId !== this.root.id)
              .error,
          }
        : {}),
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      session: this.session,
      records: this.records,
      headId: this.records.at(-1)?.id ?? null,
      activity: !this.paused && this.busy() ? "busy" : "idle",
      settings: this.settings,
    });
  }

  liveView(): AgentLiveView | null {
    if (this.operationId === null) return null;
    const blocks: AgentLiveView["blocks"][number][] = (
      this.live.generation?.message?.content ?? []
    ).flatMap((block, index) =>
      block.type === "text" || block.type === "thinking"
        ? [
            {
              blockId: `${this.session.id}:generation:${this.live.run?.taskId}:${this.live.generation?.attempt}:${index}`,
              blockType: block.type === "text" ? ("text" as const) : ("reasoning" as const),
              contentIndex: index,
              revision: this.revision,
              text: block.type === "text" ? block.text : block.thinking,
            },
          ]
        : [],
    );
    const waiting = new Set<NonNullable<LiveState["nestedTools"]>[number]["taskId"]>();
    const isWaiting = (tool: NonNullable<LiveState["tools"]>[number]) =>
      tool.status === "running" &&
      tool.details !== null &&
      typeof tool.details === "object" &&
      !Array.isArray(tool.details) &&
      tool.details.executionWait === true;
    for (const tool of [...(this.live.nestedTools ?? [])].reverse()) {
      if (isWaiting(tool) || waiting.has(tool.taskId)) waiting.add(tool.parentTaskId);
    }
    const tools = (this.live.tools ?? []).map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      revision: this.revision,
      state: tool.status === "done" ? ("completed" as const) : ("running" as const),
      ...(tool.status === "running" &&
      (isWaiting(tool) || (tool.taskId !== undefined && waiting.has(tool.taskId)))
        ? { message: "Waiting for execution." }
        : tool.output === undefined
          ? {}
          : { message: tool.output }),
    }));
    const subagents = activeSubagents(this.tasks, this.root.id, this.records);
    return {
      operationId: this.operationId,
      operationKind: this.operationKind,
      blocks,
      tools,
      subagents,
    };
  }

  notifyParent(
    message: string,
    api: ToolExecutionApi,
    invocationContext: import("@earendil-works/chord").Context,
  ): ResultAsync<{ accepted: true }, OrbAgentError> {
    const checkLocal = (): ResultAsync<void, RuntimeClientError> =>
      this.closing || this.paused || this.options.ownershipSignal?.aborted || this.failure
        ? errAsync(this.failure ?? durableError("Harness admissions closed"))
        : okAsync(undefined);
    const admit = () =>
      checkLocal()
        .andThen(() => this.options.checkAdmission?.() ?? okAsync(undefined))
        .andThen(checkLocal);
    return this.serial(
      async () => await submitParentNotification(message, api, invocationContext, admit),
    ).mapErr(
      (error): OrbAgentError => ({
        code: error.code === "invalid_response" ? "invalid_request" : "unavailable",
        message:
          error.code === "invalid_response"
            ? "Invalid notification target"
            : "Notification admission unavailable",
      }),
    );
  }

  appendAlert(
    requestId: string,
    message: string,
  ): ResultAsync<{ recordId: string; duplicate: boolean }, RuntimeClientError> {
    return this.serial(async () => {
      if (this.failure) return err(this.failure);
      const committed = await ResultAsync.fromPromise(
        this.root.commit(async (tx) => {
          const receipts = await tx.doc(AlertReceipts, this.root.id);
          const admitted = await this.options.checkAdmission?.();
          if (this.closing || this.paused || admitted?.isErr())
            return err(
              admitted?.isErr() ? admitted.error : durableError("Harness admissions closed"),
            );
          const existing = receipts[requestId];
          if (existing)
            return existing.message === message
              ? ok({ entryId: existing.entryId, duplicate: true })
              : err(durableError("alert request ID conflict"));
          const entry = await tx.appendEntry(this.root.id, {
            kind: "orb.alert",
            data: { requestId, message, timestamp: this.now() },
          });
          receipts[requestId] = { message, entryId: entry.id };
          return ok({ entryId: entry.id, duplicate: false });
        }, context),
        (error) => this.storageError(error, "alert commit failed"),
      );
      if (committed.isErr()) return err(committed.error);
      if (committed.value.isErr()) return err(committed.value.error);
      const projected = await this.projection;
      return projected.isErr()
        ? err(projected.error)
        : ok({
            recordId: `${this.session.id}:${committed.value.value.entryId}`,
            duplicate: committed.value.value.duplicate,
          });
    });
  }

  health(): RuntimeHealth {
    if (this.failure)
      return {
        v: 1,
        orbId: this.options.orbId,
        runtimeInstanceId: this.runtimeInstanceId,
        status: "failed",
        error: {
          code: "central_agent_failed",
          message: this.failure.message,
          retryable: this.failure.retryable,
        },
      };
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "ready",
      sessionId: this.session.id,
      checkoutCommit: this.options.checkoutCommit,
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      activity: !this.paused && this.busy() ? "busy" : "idle",
      ...(this.operationId ? { operationId: this.operationId } : {}),
    };
  }

  private immediateStorageFailure(error: unknown, message: string): RuntimeClientError {
    if (!(error instanceof StorageRequestError)) this.storageFailed(error);
    return this.storageError(error, message);
  }

  private storageError(error: unknown, message: string): RuntimeClientError {
    const authority = storageAuthorityError(error);
    return authority ? startupRuntimeError(authority) : (this.failure ?? durableError(message));
  }

  private serial<T>(
    operation: () => Promise<Result<T, RuntimeClientError>>,
    requiresAdmission = true,
  ): ResultAsync<T, RuntimeClientError> {
    if (this.closing || this.paused)
      return errAsync(this.failure ?? durableError("Harness admissions closed"));
    const result = this.mutations.then(async () => {
      if (this.closing || this.paused)
        return err(this.failure ?? durableError("Harness admissions closed"));
      const admitted = requiresAdmission ? await this.options.checkAdmission?.() : undefined;
      if (admitted?.isErr()) return err(admitted.error);
      if (this.closing || this.paused)
        return err(this.failure ?? durableError("Harness admissions closed"));
      return operation();
    });
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return ResultAsync.fromPromise(result, (error) =>
      this.storageError(error, "central agent operation failed"),
    ).andThen((value) => value);
  }

  deliver(
    request: DeliverMessageClientRequest,
  ): ResultAsync<DeliverOrbMessageResponse, RuntimeClientError> {
    return this.deliverMany([request]).andThen((results) => results[0]!);
  }

  deliverMany(
    requests: readonly DeliverMessageClientRequest[],
  ): ResultAsync<
    readonly Result<DeliverOrbMessageResponse, RuntimeClientError>[],
    RuntimeClientError
  > {
    return this.serial(() => this.deliverManyNow(requests));
  }

  private async deliverManyNow(
    requests: readonly DeliverMessageClientRequest[],
  ): Promise<
    Result<readonly Result<DeliverOrbMessageResponse, RuntimeClientError>[], RuntimeClientError>
  > {
    if (this.failure) return err(this.failure);
    const wasBusy = this.operationId;
    const results: Result<DeliverOrbMessageResponse, RuntimeClientError>[] = [];
    const prepared: {
      index: number;
      request: DeliverMessageClientRequest;
      receipt: Receipt;
      duplicate: boolean;
      settled: boolean;
    }[] = [];
    for (const [index, request] of requests.entries()) {
      const fingerprint = JSON.stringify({
        content: request.content,
        messageIds: request.messageIds,
        system: request.system ?? null,
      });
      const existing = this.receipts[request.messageId];
      if (existing && existing.fingerprint !== fingerprint) {
        results[index] = err(durableError("message ID conflicts with persisted content"));
        continue;
      }
      const nativeRequestId = `inbox:${request.messageId}`;
      const lookup = ResultAsync.fromThrowable(
        () => this.options.storage.submissionByRequest(this.root.id, nativeRequestId, context),
        (error) => this.immediateStorageFailure(error, "Native input lookup failed"),
      );
      let native = await lookup();
      if (native.isErr()) return err(native.error);
      if (native.value === undefined) {
        const admission = await this.options.checkInputAdmission?.(request.messageIds.length === 0);
        if (admission?.isErr()) {
          if (admission.error.type === "input_admission_failed") {
            this.failStorage(admission.error.cause);
            return err(startupRuntimeError(admission.error.cause));
          }
          // Only this request's prior native admission can override an advisory refusal.
          const latest = await lookup();
          if (latest.isErr()) return err(latest.error);
          if (latest.value === undefined) return err(admission.error.error);
          native = latest;
        }
      }
      prepared.push({
        index,
        request,
        duplicate: existing?.submissionId !== undefined,
        settled: native.value?.status === "done" || native.value?.status === "unanswered",
        receipt: existing ?? {
          fingerprint,
          operationId: wasBusy ?? `${this.session.id}:input:${request.messageId}`,
          delivery: wasBusy ? "steer" : "turn",
          messageIds: [...request.messageIds],
          ...(request.system === undefined ? {} : { system: request.system }),
        },
      });
    }
    await this.root.commit(async (tx) => {
      const identity = await tx.doc(Identity, this.root.id);
      for (const { request, receipt } of prepared) identity.receipts[request.messageId] = receipt;
    }, context);
    for (const { request, receipt } of prepared) this.receipts[request.messageId] = receipt;
    const stillAdmitted = await this.options.checkAdmission?.();
    if (this.closing || this.paused || stillAdmitted?.isErr())
      return err(
        stillAdmitted?.isErr() ? stillAdmitted.error : durableError("Harness admissions closed"),
      );
    const admitted = await ResultAsync.fromPromise(
      this.root.submitMany(
        prepared.map(({ request }) => ({
          type: "input" as const,
          content: nativeInputContent(request.content, request.system),
          requestId: `inbox:${request.messageId}`,
          whenBusy: "steer" as const,
        })),
        context,
      ),
      (error) => {
        const authority = storageAuthorityError(error);
        return authority
          ? startupRuntimeError(authority)
          : durableError("Native input admission failed", true);
      },
    );
    if (admitted.isErr()) return err(admitted.error);
    const recoveredInputId =
      admitted.value.submissions[
        prepared.findIndex(({ duplicate, settled }) => !duplicate && settled)
      ]?.id;
    for (const [index, input] of prepared.entries()) {
      const { request, receipt, duplicate, settled } = input;
      const submissionId = admitted.value.submissions[index]!.id;
      const inputId = (settled ? recoveredInputId : admitted.value.inputId) ?? submissionId;
      const nativeOperationId = `${this.session.id}:submission:${inputId}`;
      const operationId = settled ? nativeOperationId : (this.operationId ?? nativeOperationId);
      const delivery = settled
        ? receipt.delivery
        : admitted.value.busy || operationId !== nativeOperationId
          ? "steer"
          : "turn";
      const finalized: Receipt = {
        ...receipt,
        submissionId,
        delivery: duplicate ? receipt.delivery : delivery,
        operationId: duplicate ? receipt.operationId : operationId,
      };
      input.receipt = finalized;
      results[input.index] = ok({
        v: 1,
        messageId: request.messageId,
        status: "persisted",
        operationId: finalized.operationId,
        delivery: finalized.delivery,
        duplicate,
      });
    }
    await this.root.commit(async (tx) => {
      const identity = await tx.doc(Identity, this.root.id);
      for (const { request, receipt } of prepared) identity.receipts[request.messageId] = receipt;
    }, context);
    for (const { request, receipt } of prepared) this.receipts[request.messageId] = receipt;
    return ok(results);
  }

  request(
    requestId: string,
    action: ClientAction,
  ): ResultAsync<RequestResultFrame["result"], RuntimeClientError> {
    if (action.type === "message")
      return this.serial<RequestResultFrame["result"]>(async () => {
        await this.projection;
        if (
          this.receipts[`browser:${requestId}`] === undefined &&
          action.expectedHeadId !== this.records.at(-1)?.id &&
          !(action.expectedHeadId === null && this.records.length === 0)
        )
          return okAsync({
            type: "rejected",
            error: { code: "stale_head", message: "history changed", retryable: false },
          });
        const delivered = await this.deliverManyNow([
          {
            baseUrl: "central",
            messageId: `browser:${requestId}`,
            messageIds: [],
            content: action.content,
          },
        ]);
        return delivered
          .andThen((results) => results[0]!)
          .map((receipt) => ({
            type: "accepted" as const,
            operationId: receipt.operationId,
            duplicate: receipt.duplicate,
          }));
      });
    return this.serial<RequestResultFrame["result"]>(async () => {
      if (this.failure && action.type !== "abort") return err(this.failure);
      if (action.type === "set_model" || action.type === "set_thinking") {
        const previous = this.settingsReceipts[requestId];
        if (previous !== undefined)
          return previous === JSON.stringify(action)
            ? ok({ type: "settings_applied", duplicate: true })
            : ok({
                type: "rejected",
                error: {
                  code: "request_id_conflict",
                  message: "settings request ID conflicts",
                  retryable: false,
                },
              });
      }
      if (action.type === "abort") {
        const pendingMessage =
          /^inbox:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
            action.operationId,
          )?.[1];
        let pendingActive = false;
        if (pendingMessage) {
          const batches = new Set([
            pendingMessage,
            ...Object.entries(this.receipts)
              .filter(([, receipt]) => receipt.messageIds.includes(pendingMessage))
              .map(([batch]) => batch),
          ]);
          for (const batch of batches) {
            const submission = await this.options.storage.submissionByRequest(
              this.root.id,
              `inbox:${batch}`,
              context,
            );
            if (
              submission?.type === "input" &&
              (submission.status === "queued" || submission.status === "placed")
            ) {
              pendingActive = true;
              break;
            }
          }
        }
        if (action.operationId !== this.operationId && !pendingActive)
          return ok({
            type: "rejected",
            error: { code: "stale_operation", message: "operation changed", retryable: false },
          });
        await this.root.abort(context, { background: true });
        return ok({ type: "accepted", operationId: action.operationId, duplicate: false });
      }
      if (this.busy())
        return ok({
          type: "rejected",
          error: { code: "busy", message: "agent is busy", retryable: true },
        });
      if (action.type === "set_model" || action.type === "set_thinking") {
        const model =
          action.type === "set_model"
            ? this.options.models.getModel(action.model.provider, action.model.id)
            : this.settings
              ? this.options.models.getModel(
                  this.settings.settings.model.provider,
                  this.settings.settings.model.id,
                )
              : undefined;
        if (
          !model ||
          (action.type === "set_thinking" &&
            !getSupportedThinkingLevels(model).includes(action.thinkingLevel))
        )
          return ok({
            type: "rejected",
            error: {
              code: "invalid_request",
              message: "model or thinking level unavailable",
              retryable: false,
            },
          });
        const fingerprint = JSON.stringify(action);
        await this.root.commit(async (tx) => {
          const previous = publicSettings(await tx.doc(AgentDoc, this.root.id));
          await configure(
            tx,
            this.root.id,
            action.type === "set_model"
              ? { model: { provider: action.model.provider, modelId: action.model.id } }
              : { thinkingLevel: action.thinkingLevel },
          );
          const identity = await tx.doc(Identity, this.root.id);
          identity.settings ??= {};
          identity.settings[requestId] = fingerprint;
          await appendSettingsHistory(
            tx,
            this.root.id,
            previous,
            publicSettings(await tx.doc(AgentDoc, this.root.id)),
            this.now(),
          );
        }, context);
        this.settingsReceipts[requestId] = fingerprint;
        const projected = await this.projection;
        if (projected.isErr()) return err(projected.error);
        return ok({ type: "settings_applied", duplicate: false });
      }
      return ok({
        type: "rejected",
        error: { code: "unsupported", message: "unsupported action", retryable: false },
      });
    });
  }

  pullHistory(
    after: string | null,
    limit: number,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError> {
    return ResultAsync.fromPromise(this.projection, () =>
      durableError("history projection failed"),
    ).andThen((projected) => {
      if (projected.isErr()) return errAsync(projected.error);
      const index = after === null ? -1 : this.records.findIndex((record) => record.id === after);
      if (after !== null && index === -1)
        return errAsync({
          ...durableError("unknown history cursor"),
          code: "cursor_not_found" as const,
        });
      const records = this.records.slice(index + 1, index + 1 + Math.max(1, Math.min(500, limit)));
      const cursor = records.at(-1)?.id ?? after;
      return okAsync<PullHistoryResponse, RuntimeClientError>({
        v: 1,
        orbId: this.options.orbId,
        runtimeInstanceId: this.runtimeInstanceId,
        session: this.session,
        activity: !this.paused && this.busy() ? "busy" : "idle",
        records,
        cursor,
        headId: cursor,
      });
    });
  }

  prepareIdleStop(): ResultAsync<{ v: 1; prepared: boolean }, RuntimeClientError> {
    if (this.paused) return okAsync({ v: 1, prepared: true });
    return this.serial(async () => {
      if (this.failure) return err(this.failure);
      const inspection = await this.harness.inspect(context);
      if (
        inspection.tasks.length > 0 ||
        inspection.submissions.length > 0 ||
        this.pendingProjection > 0 ||
        this.pendingSummaries > 0 ||
        this.executionActive()
      )
        return ok({ v: 1, prepared: false });
      return ok({ v: 1, prepared: true });
    }, false);
  }

  waitForIdle(): ResultAsync<void, RuntimeClientError> {
    return ResultAsync.fromPromise(
      (async () => {
        await this.root.waitForIdle(context);
        await this.projection;
      })(),
      (error) => this.storageError(error, "Harness idle wait failed"),
    ).andThen(() => (this.failure ? errAsync(this.failure) : okAsync(undefined)));
  }

  close(): ResultAsync<void, RuntimeClientError> {
    if (this.closeResult) return this.closeResult;
    this.revoke();
    this.summaryAbort.abort();
    this.closeResult = ResultAsync.fromPromise(
      (async () => {
        const draining = await this.options.beginDrain?.();
        await this.mutations;
        const suspended = await ResultAsync.fromPromise(this.harness.close(context), () =>
          durableError("Harness suspension failed"),
        );
        const projected = await ResultAsync.fromPromise(this.projection, () =>
          durableError("history projection failed"),
        ).andThen((result) => result);
        await this.summaryCoordinator?.drain();
        await this.summaryOutcomes;
        this.unsubscribeCommits();
        this.unsubscribeView();
        this.unsubscribeGraph();
        this.view.dispose();
        this.graph.dispose();
        const resources = await this.options.closeResources?.();
        const failed = draining?.isErr()
          ? { stage: "drain", error: draining.error }
          : suspended.isErr()
            ? { stage: "native", error: suspended.error }
            : projected.isErr()
              ? { stage: "projection", error: projected.error }
              : resources?.isErr()
                ? { stage: "resources", error: resources.error }
                : undefined;
        const drainOutcome = draining?.isOk() ? draining.value : undefined;
        const drainCause = draining?.isErr() ? draining.error.cause : drainOutcome?.cause;
        const edge = await this.options.edge?.(
          resources?.isErr() ? "harness.resources_close_failed" : "harness.suspended",
          {
            orbId: this.options.orbId,
            sessionId: this.session.id,
            drain_outcome: draining?.isErr() ? "failed" : (drainOutcome?.type ?? "draining"),
            close_outcome: failed ? "failed" : "closed",
            ...(failed ? { failed_stage: failed.stage, error_code: failed.error.code } : {}),
            ...(drainCause ? { cause_code: drainCause.code } : {}),
          },
        );
        return failed ? err(failed.error) : edge?.isErr() ? err(edge.error) : ok(undefined);
      })(),
      () => durableError("Harness suspension failed"),
    ).andThen((value) => value);
    return this.closeResult;
  }
}
