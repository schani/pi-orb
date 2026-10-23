import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";

import { nativeCall, nativeData } from "./testkit/native-call.ts";

const ctx = BACKGROUND_CONTEXT;
it.each([
  { stopReason: "error" as const, status: "failed", output: "", reason: "model_error" },
  { stopReason: "aborted" as const, status: "aborted", output: "", reason: "aborted" },
  { stopReason: "stop" as const, status: "completed", output: "child answer", reason: undefined },
])("retains $status child receipts and rejects steering after terminal", async (scenario) => {
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let id = "";
  const observed: Record<string, Record<string, unknown>> = {};
  const respond: FauxResponseFactory = async (request, options) => {
    const user = request.messages.find((message) => message.role === "user");
    if (JSON.stringify(user?.content).includes("child prompt")) {
      entered();
      if (scenario.status === "aborted")
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      else await admitted;
      return fauxAssistantMessage(scenario.output, {
        stopReason: scenario.stopReason,
        ...(scenario.stopReason === "error" ? { errorMessage: "provider refused generation" } : {}),
      });
    }
    const last = request.messages.filter((message) => message.role === "toolResult").at(-1);
    if (!last) return fauxAssistantMessage("unexpected parent request");
    const data = nativeData(last);
    expect(last.isError).toBe(false);
    observed[last.toolCallId] = data;
    if (last.toolCallId === "subagent") {
      id = data.agent_id;
      release();
      await started;
      return fauxAssistantMessage(
        scenario.status === "aborted"
          ? nativeCall("cancel_subagent", { agent_id: id })
          : nativeCall("get_subagent_result", { agent_id: id, wait: true }),
        { stopReason: "toolUse" },
      );
    }
    if (last.toolCallId === "cancel_subagent")
      return fauxAssistantMessage(nativeCall("get_subagent_result", { agent_id: id, wait: true }), {
        stopReason: "toolUse",
      });
    if (last.toolCallId === "get_subagent_result")
      return fauxAssistantMessage(
        nativeCall("steer_subagent", { agent_id: id, message: "too late" }),
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("parent done");
  };
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(nativeCall("subagent", { prompt: "child prompt" }), {
      stopReason: "toolUse",
    }),
    ...Array(5).fill(respond),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = createDurableTools();
  const registry = createRegistry();
  registry.install(tools.extension);
  registry.install(tools.childExtension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { retry: { enabled: false } },
    },
    ctx,
  );
  try {
    const root = await harness.root(ctx, {
      agent: {
        model: { provider: "faux", modelId: "faux-1" },
        modelTools: tools.modelTools,
        extensions: { remove: [tools.childExtension] },
      },
    });
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    const entries = (
      await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, ctx)
    ).items;
    const tasks = entries.filter((entry) => entry.kind === "orb.subagent-task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.data).toMatchObject({ prompt: "child prompt", description: "" });
    const submissions = (await storage.scanSubmissions({}, 100, undefined, ctx)).items;
    const childInput = submissions.find((submission) =>
      submission.requestId?.startsWith("anchor:"),
    );
    expect(childInput).toMatchObject(
      scenario.reason ? { status: "unanswered", reason: scenario.reason } : { status: "done" },
    );
    if (scenario.status === "failed")
      expect(childInput).toMatchObject({ detail: "provider refused generation" });
    expect(observed.get_subagent_result).toMatchObject({
      agent_id: id,
      status: scenario.status,
      receipt: { status: scenario.status },
    });
    if (scenario.status === "failed")
      expect(observed.get_subagent_result).toMatchObject({
        receipt: {
          error: { message: "provider refused generation", detail: { reason: "model_error" } },
        },
      });
    if (scenario.status === "completed")
      expect(observed.get_subagent_result).toMatchObject({
        receipt: { result: { output: "child answer" } },
      });
    expect(observed.steer_subagent).toMatchObject({ error: "Subagent is not accepting input" });
    expect(observed.steer_subagent?.status).not.toBe("accepted");
    expect(submissions.some((submission) => submission.requestId?.startsWith("steer:"))).toBe(
      false,
    );
  } finally {
    release();
    await harness.close(ctx);
    await tools.close();
  }
});
