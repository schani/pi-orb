import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type ConversationId,
  defineDoc,
  defineTask,
  defineTool,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

type Receipt = { anchor: number; prompt: string; description: string };
export const ChildReceipts = defineDoc<{ children: Record<string, Receipt> }>({
  kind: "orb.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: {} }),
});
const ChildControl = defineDoc<{ cancelled: boolean }>({
  kind: "orb.child-control",
  version: 1,
  scope: "task",
  initial: () => ({ cancelled: false }),
});
type State =
  | { phase: "create" }
  | { phase: "run"; child: number }
  | { phase: "finish"; child: number };
/** A conversation-owned anchor survives the spawning tool and owns the child's entire scope. */
export const ChildAnchor = defineTask<{ prompt: string }, State, JsonValue>({
  name: "orb.child",
  version: 1,
  initial: () => ({ phase: "create" }),
  phases: {
    create: async (_task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        if ((await tx.doc(ChildControl, runtime.taskId)).cancelled)
          return { status: "terminal", outcome: { status: "aborted" } };
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: runtime.taskId },
        });
        (await tx.doc(AgentDoc, child.id)).tools = ["codemode"];
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
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
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
  return {
    agent_id: id,
    description: row.description,
    status: task?.state.status === "terminal" ? task.state.outcome.status : "running",
    ...(task?.state.status === "terminal" ? { receipt: task.state.outcome } : {}),
  };
}
export const subagentTools = [
  defineTool({
    name: "subagent",
    description:
      "Start a background subagent in the shared checkout. Returns agent_id immediately. Inherits parent model, instructions and authorized tools. No profiles, kinds or model selectors.",
    parameters: Type.Object(
      { prompt: Type.String(), description: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const id = await api.commit(async (tx) => {
        const doc = await tx.doc(ChildReceipts, api.conversationId);
        const key = `${api.taskId}:${api.callId}`;
        if (doc.children[key]) return key;
        const anchor = await tx.createTask(
          ChildAnchor,
          { prompt: args.prompt },
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
    description: "Get subagent status and its persistent completion receipt; optionally wait.",
    parameters: Type.Object(
      { agent_id: Type.String(), wait: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) =>
      result(await status(api, args.agent_id, args.wait ?? false, ctx)),
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
      return result(await status(api, args.agent_id, true, ctx));
    },
  }),
];
