import type { Context, JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type ConversationId,
  defineDoc,
  defineTask,
  defineTool,
  InboxDoc,
  type ModelRef,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  eligibleCodexModels,
  SELECTABLE_CODEX_MODELS,
} from "../../../../../orb-runtime/src/domain/model-select.ts";
import { errorResult, type ToolError } from "./catalog.ts";

export const TOOLS_EXTENSION = "orb.tools";
export const SUBAGENT_TOOL_NAMES: readonly string[] = [
  "subagent",
  "steer_subagent",
  "get_subagent_result",
  "list_subagents",
  "cancel_subagent",
];
/** Selected only by children: their codemode lacks subagent tools, orb_spawn and orb_alert. */
export const CHILD_TOOLS_EXTENSION = "orb.child-tools";
type Receipt = { anchor: number; prompt: string; description: string; model?: string };
export const ChildReceipts = defineDoc<{ children: Record<string, Receipt> }>({
  kind: "orb.children",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: {} }),
});
const ChildControl = defineDoc<{ cancelled: boolean }>({
  kind: "orb.child-control",
  version: 1,
  checkpointWhen: () => false,
  scope: "task",
  initial: () => ({ cancelled: false }),
});
type State =
  | { phase: "create" }
  | { phase: "run"; child: number }
  | { phase: "finish"; child: number };
/** A conversation-owned anchor survives the spawning tool and owns the child's entire scope. */
export const ChildAnchor = defineTask<
  { prompt: string; description: string; model?: ModelRef },
  State,
  JsonValue
>({
  name: "orb.child",
  version: 1,
  initial: () => ({ phase: "create" }),
  phases: {
    create: async (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        if ((await tx.doc(ChildControl, runtime.taskId)).cancelled)
          return { status: "terminal", outcome: { status: "aborted" } };
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: runtime.taskId },
        });
        const agent = await tx.doc(AgentDoc, child.id);
        agent.tools = (runtime.registry.extension(CHILD_TOOLS_EXTENSION)?.tools ?? [])
          .map((tool) => tool.name)
          .filter((name) => name !== "orb_spawn" && !SUBAGENT_TOOL_NAMES.includes(name));
        agent.modelTools = ["codemode"];
        agent.extensions = { remove: [TOOLS_EXTENSION] };
        if (task.input.model) agent.model = task.input.model;
        await tx.appendEntry(ROOT_CONVERSATION_ID, {
          kind: "orb.subagent-task",
          data: {
            childId: child.id,
            prompt: task.input.prompt,
            description: task.input.description,
            // Materialized by pi-durable's creation hook in this commit; names the child's `model_calls` rows.
            sessionId: (await tx.doc(ProviderDoc, child.id)).sessionId,
            timestamp: runtime.now(),
          },
        });
        return { status: "running", checkpoint: { phase: "run", child: child.id } };
      }, ctx),
    run: async (task, runtime, ctx) => {
      const child = await runtime.conversation(task.state.checkpoint.child as ConversationId, ctx);
      if (!child) return;
      if ((await runtime.snapshot(ChildControl, runtime.taskId, ctx))?.cancelled) {
        await runtime.commit(
          async () => ({ status: "terminal", outcome: { status: "aborted" } }),
          ctx,
        );
        return;
      }
      const input = await child.submit(
        { type: "input", content: task.input.prompt, requestId: `anchor:${runtime.taskId}` },
        ctx,
      );
      if ((await runtime.snapshot(ChildControl, runtime.taskId, ctx))?.cancelled)
        await child.abort(ctx, { background: true });
      const settled = await input.wait(ctx);
      if (settled.status === "unanswered") {
        await runtime.commit(
          async (tx) => ({
            status: "terminal",
            outcome:
              (await tx.doc(ChildControl, runtime.taskId)).cancelled || settled.reason === "aborted"
                ? { status: "aborted" }
                : {
                    status: "failed",
                    error: {
                      message: typeof settled.detail === "string" ? settled.detail : settled.reason,
                      detail: {
                        reason: settled.reason,
                        ...(settled.detail === undefined ? {} : { detail: settled.detail }),
                      },
                    },
                  },
          }),
          ctx,
        );
        return;
      }
      await runtime.commit(
        async () => ({
          status: "running",
          checkpoint: { phase: "finish", child: task.state.checkpoint.child },
        }),
        ctx,
      );
    },
    finish: async (task, runtime, ctx) => {
      const child = await runtime.conversation(task.state.checkpoint.child as ConversationId, ctx);
      await child?.waitForIdle(ctx);
      const view = await runtime.context(task.state.checkpoint.child as ConversationId, ctx);
      const output = view.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      await runtime.commit(
        async (tx) =>
          (await tx.doc(ChildControl, runtime.taskId)).cancelled
            ? { status: "terminal", outcome: { status: "aborted" } }
            : {
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: { output },
                },
              },
        ctx,
      );
    },
  },
  abort: async (_task, runtime, ctx) =>
    runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
const result = (data: unknown) => ({
  output: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const idSchema = Type.Object({ agent_id: Type.String() }, { additionalProperties: false });
async function receipt(api: ToolExecutionApi, id: string, ctx: Context) {
  return (await api.snapshot(ChildReceipts, api.conversationId, ctx))?.children[id];
}
async function status(api: ToolExecutionApi, id: string, wait: boolean, ctx: Context) {
  const row = await receipt(api, id, ctx);
  if (!row) return { agent_id: id, error: "Subagent doesn't exist" };
  const task = wait
    ? await api.waitForTask(row.anchor as TaskId, ctx)
    : await api.getTask(row.anchor as TaskId, ctx);
  return statusValue(id, row, task);
}
function statusValue(
  id: string,
  row: Receipt,
  task: Awaited<ReturnType<ToolExecutionApi["getTask"]>>,
) {
  return {
    agent_id: id,
    description: row.description,
    ...(row.model ? { model: row.model } : {}),
    status: task?.state.status === "terminal" ? task.state.outcome.status : "running",
    ...(task?.state.status === "terminal" ? { receipt: task.state.outcome } : {}),
  };
}
type WaitError = { code: "cancelled" | "unavailable"; message: string };
const waitError = (stage: string, ctx: Context) => (): WaitError => ({
  code: ctx.abortSignal?.aborted ? "cancelled" : "unavailable",
  message: `Subagent wait ${stage} failed`,
});
/** Observe parent input without changing the child task or any ordinary join. */
function waitForChild(api: ToolExecutionApi, id: TaskId, ctx: Context) {
  return ResultAsync.fromSafePromise(
    (async () => {
      const acquired = await ResultAsync.fromThrowable(
        () => api.watchDoc(InboxDoc, api.conversationId, ctx),
        waitError("watch acquisition", ctx),
      )();
      if (acquired.isErr()) return err(acquired.error);
      const watch = acquired.value;
      if (!watch)
        return err<never, WaitError>({
          code: "unavailable",
          message: "Subagent wait parent inbox unavailable",
        });
      let steer!: (value: Result<"parent_input", WaitError>) => void;
      const input = new Promise<Result<"parent_input", WaitError>>((resolve) => {
        steer = resolve;
      });
      const pending = (value: typeof watch.value) => {
        if (value?.items.some((item) => item.mode === "steer")) steer(ok("parent_input"));
      };
      pending(watch.value);
      const started = Result.fromThrowable(
        () =>
          watch.start(async (value) => {
            pending(value);
          }),
        waitError("watch start", ctx),
      )();
      const local = withCancel(ctx);
      const completion = started.isOk()
        ? ResultAsync.fromThrowable(
            () => api.waitForTask(id, local.context),
            waitError("completion", ctx),
          )().map(() => "completed" as const)
        : undefined;
      const closed = ResultAsync.fromThrowable(
        () => watch.closed,
        waitError("watch close", ctx),
      )().andThen((end) =>
        err<never, WaitError>({
          code: end.reason === "cancelled" ? "cancelled" : "unavailable",
          message: `Subagent wait watch ended: ${end.reason}`,
        }),
      );
      const winner = completion ? await Promise.race([completion, input, closed]) : started;
      // Only the local observing context is cancelled; the target task survives.
      local.cancel();
      if (completion) await completion;
      const stopped = await ResultAsync.fromThrowable(
        () => watch.stop(),
        waitError("watch cleanup", ctx),
      )();
      if (stopped.isErr()) return err(stopped.error);
      if (stopped.value.reason !== "stopped")
        return err<never, WaitError>({
          code: stopped.value.reason === "cancelled" ? "cancelled" : "unavailable",
          message: `Subagent wait watch ended: ${stopped.value.reason}`,
        });
      if (winner.isErr()) return err(winner.error);
      const task = await ResultAsync.fromThrowable(
        () => api.getTask(id, ctx),
        waitError("receipt read", ctx),
      )();
      if (task.isErr()) return err(task.error);
      if (ctx.abortSignal?.aborted)
        return err<never, WaitError>({
          code: "cancelled",
          message: "Subagent wait cancelled",
        });
      return ok({
        task: task.value,
        interrupted: winner.value === "parent_input" && task.value?.state.status !== "terminal",
      });
    })(),
  ).andThen((value) => value);
}
async function waitStatus(api: ToolExecutionApi, id: string, ctx: Context) {
  const rows = await ResultAsync.fromThrowable(
    () => api.snapshot(ChildReceipts, api.conversationId, ctx),
    waitError("subagent lookup", ctx),
  )();
  if (rows.isErr()) return errorResult(rows.error);
  const row = rows.value?.children[id];
  if (!row) return result({ agent_id: id, error: "Subagent doesn't exist" });
  const waited = await waitForChild(api, row.anchor as TaskId, ctx);
  if (waited.isErr()) return errorResult(waited.error);
  return result({
    ...statusValue(id, row, waited.value.task),
    ...(waited.value.interrupted ? { interrupted: "parent_input" } : {}),
  });
}
export const createSubagentTools = (
  abortTask: (id: TaskId, context: Context) => ResultAsync<void, ToolError>,
) => [
  defineTool({
    name: "subagent",
    description:
      "Start a background subagent in the shared checkout. Returns agent_id immediately. Inherits parent instructions and authorized tools, but cannot start subagents or orbs. Runs on model, or the parent's model when omitted. No profiles or kinds.",
    parameters: Type.Object(
      {
        prompt: Type.String(),
        description: Type.Optional(Type.String()),
        model: Type.Optional(
          Type.Union(SELECTABLE_CODEX_MODELS.map(({ name }) => Type.Literal(name))),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const selected = SELECTABLE_CODEX_MODELS.find(({ name }) => name === args.model);
      if (
        selected &&
        !eligibleCodexModels(api.models.getModels("openai-codex")).some(
          ({ id }) => id === selected.id,
        )
      )
        return result({ error: `Model unavailable: ${selected.name}` });
      const id = await api.commit(async (tx) => {
        const doc = await tx.doc(ChildReceipts, api.conversationId);
        const key = `${api.taskId}:${api.callId}`;
        if (doc.children[key]) return key;
        const anchor = await tx.createTask(
          ChildAnchor,
          {
            prompt: args.prompt,
            description: args.description ?? "",
            ...(selected ? { model: { provider: "openai-codex", modelId: selected.id } } : {}),
          },
          {
            conversationId: api.conversationId,
            ownership: { kind: "conversation" },
            background: true,
          },
        );
        doc.children[key] = {
          anchor,
          prompt: args.prompt,
          description: args.description ?? "",
          ...(selected ? { model: selected.name } : {}),
        };
        return key;
      }, ctx);
      return result({ agent_id: id });
    },
  }),
  defineTool({
    name: "steer_subagent",
    description: "Send input to a subagent.",
    parameters: Type.Object(
      { agent_id: Type.String(), message: Type.String() },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const row = await receipt(api, args.agent_id, ctx);
      const task = row ? await api.getTask(row.anchor as TaskId, ctx) : undefined;
      const checkpoint =
        task?.state.status === "pending" ||
        task?.state.status === "running" ||
        task?.state.status === "sleeping" ||
        task?.state.status === "waiting"
          ? task.state.checkpoint
          : undefined;
      const childId =
        checkpoint && typeof checkpoint === "object" && "child" in checkpoint
          ? checkpoint.child
          : undefined;
      if (typeof childId !== "number") return result({ error: "Subagent is not accepting input" });
      const child = await api.conversation(childId as ConversationId, ctx);
      await child?.submit(
        {
          type: "input",
          content: args.message,
          whenBusy: "steer",
          requestId: `steer:${api.taskId}:${api.callId}`,
        },
        ctx,
      );
      return result({ agent_id: args.agent_id, status: "accepted" });
    },
  }),
  defineTool({
    name: "get_subagent_result",
    description:
      "Get subagent status and its persistent completion receipt; optionally wait. Pending parent steering interrupts the wait, not the child.",
    parameters: Type.Object(
      { agent_id: Type.String(), wait: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) =>
      args.wait
        ? waitStatus(api, args.agent_id, ctx)
        : result(await status(api, args.agent_id, false, ctx)),
  }),
  defineTool({
    name: "list_subagents",
    description: "List this conversation's subagents.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const rows = (await api.snapshot(ChildReceipts, api.conversationId, ctx))?.children ?? {};
      return result(await Promise.all(Object.keys(rows).map((id) => status(api, id, false, ctx))));
    },
  }),
  defineTool({
    name: "cancel_subagent",
    description: "Cancel only this subagent and its descendants.",
    parameters: idSchema,
    replay: "safe",
    execute: async (args, api, ctx) => {
      const row = await receipt(api, args.agent_id, ctx);
      if (!row) return result({ error: "Subagent doesn't exist" });
      const checkpoint = await api.commit(async (tx) => {
        const task = await tx.task(row.anchor as TaskId);
        if (!task || task.state.status === "terminal") return undefined;
        (await tx.doc(ChildControl, row.anchor as TaskId)).cancelled = true;
        return task.state.checkpoint;
      }, ctx);
      const childId =
        typeof checkpoint === "object" && checkpoint !== null && "child" in checkpoint
          ? checkpoint.child
          : undefined;
      if (typeof childId === "number") {
        const child = await api.conversation(childId as ConversationId, ctx);
        await child?.abort(ctx, { background: true });
      }
      const aborted = await abortTask(row.anchor as TaskId, ctx);
      if (aborted.isErr()) return errorResult(aborted.error);
      return result(await status(api, args.agent_id, true, ctx));
    },
  }),
];
