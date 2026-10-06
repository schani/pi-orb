import { createHash, randomUUID } from "node:crypto";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type AgentState,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Cursor,
  configure,
  defineDoc,
  type EntryRecord,
  type EnvTarget,
  Harness,
  type LiveState,
  type Registry,
  type Storage,
  type TaskGraph,
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
  buildTurnSummaryInput,
  type TurnSummarizer,
  TurnSummaryCoordinator,
} from "../../../../orb-runtime/src/domain/turn-summary.ts";
import {
  instructionsAdoption,
  PERSONAL_INSTRUCTIONS_ADOPTION,
  PROJECT_INSTRUCTIONS_ADOPTION,
} from "../../../../orb-runtime/src/pi/instructions-adoption.ts";
import {
  codexModelDisplayName,
  eligibleCodexModels,
  PINNED_CODEX_MODEL_ID,
} from "../../../../orb-runtime/src/pi/model-select.ts";
import type { AgentLiveView, AgentSessionFacade, AgentSnapshot } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { DeliverMessageClientRequest } from "../../domain/ports.ts";
import { durableError } from "./manager.ts";
import { fenceModels } from "./model-fence.ts";
import { nativeInputContent } from "./native-input.ts";
import { activeSubagents, type PublicEntryReceipt, projectHistory } from "./projection.ts";
import { promptExtension } from "./prompt.ts";

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
  readonly prompt?: (conversationId: string, generationId?: string) => string;
  readonly resume?: boolean;
  readonly checkAdmission?: () => ResultAsync<void, RuntimeClientError>;
  readonly beginDrain?: () => ResultAsync<void, RuntimeClientError>;
  readonly openSignal?: AbortSignal;
  readonly ownershipSignal?: AbortSignal;
  readonly executionActive?: () => boolean;
  readonly hydrateExecution?: (
    context: import("@earendil-works/chord").Context,
  ) => ResultAsync<void, RuntimeClientError>;
  readonly models: Models;
  readonly registry: Registry;
  readonly modelTools?: readonly ToolRegistration[];
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
  private readonly liveBlocks = new Map<string, Set<string>>();
  private readonly retiredBlocks = new Map<string, string[]>();
  private session = { id: "", timestamp: "", overflow: {} };
  private settings: AgentSettingsEvent | null = null;
  private live: LiveState = {};
  private inboxCount = 0;
  private tasks: TaskGraph = { tasks: {} };
  private operationId: string | null = null;
  private readonly operationKind = "agent";
  private closing = false;
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
    let reported = false;
    let resourceClose: ResultAsync<void, RuntimeClientError> | undefined;
    const closeResources = () =>
      (resourceClose ??= options.closeResources?.() ?? okAsync(undefined));
    return ResultAsync.fromPromise(
      (async () => {
        options.registry.install(promptExtension(options.prompt ?? options.instructions));
        stage = "storage";
        harness = await Harness.open(
          options.storage,
          {
            models: options.checkAdmission
              ? fenceModels(options.models, options.checkAdmission, options.ownershipSignal)
              : options.models,
            registry: options.registry,
            env: (target) => options.envFor?.(target) ?? options.env,
            ...(options.now === undefined ? {} : { now: options.now }),
            onReport: () => {
              reported = true;
              owner?.reportFailure();
              void options.edge?.("harness.reported_failure", { orbId: options.orbId });
            },
          },
          context,
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
          return {
            sessionId: doc.sessionId,
            timestamp: doc.timestamp,
            receipts: JSON.parse(JSON.stringify(doc.receipts)) as Record<string, Receipt>,
            settings: JSON.parse(JSON.stringify(doc.settings ?? {})) as Record<string, string>,
          };
        }, context);
        await root.configure(
          { cwd: options.env.cwd, ...(options.modelTools ? { tools: options.modelTools } : {}) },
          context,
        );
        const agent = new DurableAgent({ ...options, closeResources }, harness, root);
        owner = agent;
        if (reported) agent.reportFailure();
        agent.session = {
          id: identity.sessionId,
          timestamp: new Date(identity.timestamp).toISOString(),
          overflow: { harness: "pi-durable" },
        };
        agent.receipts = identity.receipts;
        agent.settingsReceipts = identity.settings;
        let submissionCursor: Cursor | undefined;
        do {
          const page = await options.storage.scanSubmissions(
            { conversationId: root.id },
            256,
            submissionCursor,
            context,
          );
          for (const submission of page.items)
            if (submission.entry !== undefined && submission.requestId?.startsWith("inbox:"))
              agent.inboxEntries.set(submission.entry, submission.requestId.slice(6));
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
              change.value.entry !== undefined &&
              change.value.requestId?.startsWith("inbox:")
            )
              agent.inboxEntries.set(change.value.entry, change.value.requestId.slice(6));
          }
          if (changed) agent.queueProjection();
        });
        const recoveredTasks = Object.keys(agent.tasks.tasks);
        if (recoveredTasks.length > 0 && options.resume !== false) {
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
          recovered: recoveredTasks.length > 0,
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
        if (options.resume !== false) harness.resume();
        return ok(agent);
      })(),
      () => durableError(`central Harness initialization failed (${stage})`),
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

  private reportFailure(): void {
    this.publish({
      v: 1,
      type: "server.error",
      at: new Date(this.now()).toISOString(),
      error: {
        code: "central_agent_report",
        message: "Agent extension reported a failure",
        retryable: false,
      },
    });
    void ResultAsync.fromPromise(this.harness.inspect(context), () =>
      durableError("Harness inspection failed"),
    ).then((inspection) => {
      if (
        inspection.isErr() ||
        inspection.value.tasks.some((task) => task.state.kind === "blocked")
      ) {
        this.failure = inspection.isErr()
          ? inspection.error
          : durableError("Agent execution is blocked");
        this.operationOutcome = "failed";
        void this.options.edge?.("harness.execution_blocked", { orbId: this.options.orbId });
      }
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
  hydrateExecution(
    ctx: import("@earendil-works/chord").Context,
  ): ResultAsync<void, RuntimeClientError> {
    return this.options.hydrateExecution?.(ctx) ?? okAsync(undefined);
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
    this.inboxCount =
      (value.docs["pi.inbox"] as { items?: unknown[] } | undefined)?.items?.length ?? 0;
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
    if (active && this.operationId === null) {
      const input = this.live.run?.inputs[0];
      this.operationId = `${this.session.id}:submission:${input ?? this.live.run?.taskId ?? "children"}`;
      this.operationOutcome = "completed";
      this.turnStart = this.records.length;
      this.emit({ type: "operation_started", operationId: this.operationId });
    } else if (!active && this.operationId !== null) {
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
    this.pendingProjection++;
    this.projection = this.projection
      .then(async (previous) => {
        if (previous.isErr()) return previous;
        const receipts = new Map<number, PublicEntryReceipt>();
        for (const [entryId, messageId] of this.inboxEntries) {
          const receipt = this.receipts[messageId];
          if (receipt) receipts.set(entryId, receipt);
        }
        const projected = projectHistory(entries, this.session.id, receipts);
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
            if (record.type === "message" && record.role === "assistant")
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
        return result;
      });
    return this.projection;
  }

  snapshot(): Result<AgentSnapshot, { message: string }> {
    if (this.failure) return err({ message: this.failure.message });
    return ok({
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
              revision: this.revision,
              text: block.type === "text" ? block.text : block.thinking,
            },
          ]
        : [],
    );
    const tools = (this.live.tools ?? []).map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      revision: this.revision,
      state: tool.status === "done" ? ("completed" as const) : ("running" as const),
      ...(tool.details &&
      typeof tool.details === "object" &&
      !Array.isArray(tool.details) &&
      tool.details.executionWait === true
        ? { message: "Waiting for execution." }
        : tool.output === undefined
          ? {}
          : { message: tool.output }),
    }));
    const subagents = activeSubagents(this.tasks, this.root.id);
    return {
      operationId: this.operationId,
      operationKind: this.operationKind,
      blocks,
      tools,
      subagents,
    };
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
        () => durableError("alert commit failed"),
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

  private serial<T>(
    operation: () => Promise<Result<T, RuntimeClientError>>,
    requiresAdmission = true,
  ): ResultAsync<T, RuntimeClientError> {
    if (this.closing || this.paused) return errAsync(durableError("Harness admissions closed"));
    const result = this.mutations.then(async () => {
      if (this.closing || this.paused) return err(durableError("Harness admissions closed"));
      const admitted = requiresAdmission ? await this.options.checkAdmission?.() : undefined;
      if (admitted?.isErr()) return err(admitted.error);
      if (this.closing || this.paused) return err(durableError("Harness admissions closed"));
      return operation();
    });
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return ResultAsync.fromPromise(result, () =>
      durableError("central agent operation failed"),
    ).andThen((value) => value);
  }

  deliver(
    request: DeliverMessageClientRequest,
  ): ResultAsync<DeliverOrbMessageResponse, RuntimeClientError> {
    return this.serial(() => this.deliverNow(request));
  }

  private async deliverNow(
    request: DeliverMessageClientRequest,
  ): Promise<Result<DeliverOrbMessageResponse, RuntimeClientError>> {
    if (this.failure) return err(this.failure);
    const fingerprint = JSON.stringify({
      content: request.content,
      messageIds: request.messageIds,
      system: request.system ?? null,
    });
    const existing = this.receipts[request.messageId];
    if (existing && existing.fingerprint !== fingerprint)
      return err(durableError("message ID conflicts with persisted content"));
    const delivery = existing?.delivery ?? (this.live.run ? "steer" : "turn");
    const wasBusy = this.operationId;
    const content = nativeInputContent(request.content, request.system);
    if (!existing) {
      const admitted: Receipt = {
        fingerprint,
        operationId: wasBusy ?? `${this.session.id}:input:${request.messageId}`,
        delivery,
        messageIds: [...request.messageIds],
        ...(request.system === undefined ? {} : { system: request.system }),
      };
      await this.root.commit(async (tx) => {
        (await tx.doc(Identity, this.root.id)).receipts[request.messageId] = admitted;
      }, context);
      this.receipts[request.messageId] = admitted;
    }
    const stillAdmitted = await this.options.checkAdmission?.();
    if (this.closing || this.paused || stillAdmitted?.isErr())
      return err(
        stillAdmitted?.isErr() ? stillAdmitted.error : durableError("Harness admissions closed"),
      );
    const submitted = await this.root.submit(
      { type: "input", content, requestId: `inbox:${request.messageId}`, whenBusy: "steer" },
      context,
    );
    const operationId =
      existing?.submissionId !== undefined
        ? existing.operationId
        : (wasBusy ?? `${this.session.id}:submission:${submitted.id}`);
    const receipt = {
      fingerprint,
      operationId,
      delivery,
      submissionId: submitted.id,
      messageIds: [...request.messageIds],
      ...(request.system === undefined ? {} : { system: request.system }),
    };
    await this.root.commit(async (tx) => {
      (await tx.doc(Identity, this.root.id)).receipts[request.messageId] = receipt;
    }, context);
    this.receipts[request.messageId] = receipt;
    return ok({
      v: 1,
      messageId: request.messageId,
      status: "persisted",
      operationId,
      delivery,
      duplicate: existing !== undefined,
    });
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
        const delivered = await this.deliverNow({
          baseUrl: "central",
          messageId: `browser:${requestId}`,
          messageIds: [],
          content: action.content,
        });
        return delivered.map((receipt) => ({
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
      () => durableError("Harness idle wait failed"),
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
        await this.projection;
        await this.summaryCoordinator?.drain();
        await this.summaryOutcomes;
        this.unsubscribeCommits();
        this.unsubscribeView();
        this.unsubscribeGraph();
        this.view.dispose();
        this.graph.dispose();
        const resources = await this.options.closeResources?.();
        const edge = await this.options.edge?.(
          resources?.isErr() ? "harness.resources_close_failed" : "harness.suspended",
          {
            orbId: this.options.orbId,
            sessionId: this.session.id,
          },
        );
        return draining?.isErr()
          ? err(draining.error)
          : suspended.isErr()
            ? err(suspended.error)
            : resources?.isErr()
              ? err(resources.error)
              : edge?.isErr()
                ? err(edge.error)
                : ok(undefined);
      })(),
      () => durableError("Harness suspension failed"),
    ).andThen((value) => value);
    return this.closeResult;
  }
}
