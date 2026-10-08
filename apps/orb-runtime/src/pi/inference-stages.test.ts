import { AsyncLocalStorage } from "node:async_hooks";
import { Agent } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { createStreamTelemetryExtension } from "./extensions/stream-telemetry.ts";
import { type InferenceStageAudit, installInferenceStages } from "./inference-stages.ts";
import { StreamTelemetry } from "./stream-telemetry.ts";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("records SSE HTTP entry before fetch without retaining request data", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  if (!model) throw new Error("missing pinned model");
  const held = gate();
  const entered = gate();
  const fetch = async () => {
    entered.release();
    await held.promise;
    return new Response("SECRET");
  };
  const agent = new Agent({
    initialState: { model },
    streamFn: async (_model, _context, options) => {
      await options?.fetch?.("https://secret.invalid", {
        headers: { authorization: "SECRET" },
        body: "SECRET",
      });
      throw new Error("native fixture terminal");
    },
  });
  const rows: InferenceStageAudit[] = [];
  installInferenceStages(agent, {
    now: () => 123,
    identity: () => ({ operationId: "op", sessionId: "root" }),
    audit: (row) => {
      rows.push(row);
      return ok(undefined);
    },
    failed: () => expect.fail("audit failure"),
  });
  const pending = agent.streamFunction(model, normalizeContext({ messages: [] }), { fetch });
  const terminal = Promise.resolve(pending).catch(() => undefined);
  await entered.promise;
  expect(rows.findLast((row) => row.stage === "provider_http")).toMatchObject({ edge: "enter" });
  expect(JSON.stringify(rows)).not.toContain("SECRET");
  expect(JSON.stringify(rows)).not.toContain("secret.invalid");
  held.release();
  await terminal;
  expect(rows.findLast((row) => row.stage === "provider_http")).toMatchObject({ edge: "exit" });
});

it("keeps delayed root auth and HTTP phases owned by their stream invocation", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  if (!model) throw new Error("missing pinned model");
  const dispatch = gate();
  const signal = new AbortController().signal;
  const runtime: Pick<ModelRuntime, "getAuth"> = { getAuth: async () => undefined };
  const agent = new Agent({
    initialState: { model },
    streamFn: async (_model, _context, options) => {
      await dispatch.promise;
      await runtime.getAuth(model, options?.signal ? { signal: options.signal } : {});
      await options?.fetch?.("https://fixture.invalid");
      throw new Error("native fixture terminal");
    },
  });
  const rows: InferenceStageAudit[] = [];
  let identity = { operationId: "opA", sessionId: "rootA" };
  installInferenceStages(
    agent,
    {
      now: () => 123,
      identity: () => identity,
      audit: (row) => {
        rows.push(row);
        return ok(undefined);
      },
      failed: () => expect.fail("audit failure"),
    },
    runtime,
  );
  const pending = Promise.resolve(
    agent.streamFunction(model, normalizeContext({ messages: [] }), {
      signal,
      fetch: async () => new Response(),
    }),
  ).catch(() => undefined);
  identity = { operationId: "opB", sessionId: "rootB" };
  dispatch.release();
  await pending;
  for (const stage of ["auth_resolution", "provider_http"] as const) {
    const phases = rows.filter((row) => row.stage === stage);
    expect(phases.map((row) => row.edge)).toEqual(["enter", "exit"]);
    expect(phases).toEqual([
      expect.objectContaining({ operationId: "opA", sessionId: "rootA" }),
      expect.objectContaining({ operationId: "opA", sessionId: "rootA" }),
    ]);
  }
  const count = rows.length;
  await runtime.getAuth(model, { signal: new AbortController().signal });
  await runtime.getAuth(model);
  expect(rows).toHaveLength(count);
});

it("keeps delayed provider header and payload dispatch in the invocation's operation context", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  if (!model) throw new Error("missing pinned model");
  const dispatch = gate();
  const context = new AsyncLocalStorage<string | null>();
  const handlers = new Map<string, (event: never, context: never) => void>();
  const rows: Omit<InferenceStageAudit, "observedAt">[] = [];
  const telemetry = new StreamTelemetry(() => 123);
  let operationId: string | null = "opA";
  const extension = createStreamTelemetryExtension({
    telemetry,
    operationId: () => {
      const owner = context.getStore();
      return owner === undefined ? operationId : owner;
    },
    rootSessionId: () => "root",
    audit: () => ok(undefined),
    stage: (row) => {
      rows.push(row);
      return ok(undefined);
    },
    failed: () => expect.fail("audit failure"),
  });
  extension({
    on: (name: string, handler: (event: never, context: never) => void) =>
      handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const agent = new Agent({
    initialState: { model },
    streamFn: async () => {
      await dispatch.promise;
      for (const event of ["before_provider_headers", "before_provider_request"]) {
        handlers.get(event)?.(
          {} as never,
          { sessionManager: { getSessionId: () => "root" } } as never,
        );
      }
      throw new Error("native fixture terminal");
    },
  });
  installInferenceStages(agent, {
    now: () => 123,
    identity: () => ({ operationId, sessionId: "root" }),
    withIdentity: (owner, run) => context.run(owner.operationId, run),
    audit: () => ok(undefined),
    failed: () => expect.fail("audit failure"),
  });
  const pending = Promise.resolve(
    agent.streamFunction(model, normalizeContext({ messages: [] })),
  ).catch(() => undefined);
  operationId = "opB";
  dispatch.release();
  await pending;
  expect(rows).toMatchObject([
    { operationId: "opA", stage: "provider_headers", edge: "enter" },
    { operationId: "opA", stage: "provider_headers", edge: "exit" },
  ]);
  expect(telemetry.snapshot()).toMatchObject([{ operationId: "opA" }]);
  expect(context.getStore()).toBeUndefined();
});

it.each([
  "finishTurn",
  "prepareNextTurnWithContext",
  "prepareRequest",
  "transformContext",
  "streamFunction",
] as const)("records %s before its native await and preserves its return", async (method) => {
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  if (!model) throw new Error("missing pinned model");
  const agent = new Agent({
    initialState: { model },
    streamFn: async () => {
      throw new Error("unused");
    },
  });
  const held = gate();
  const entered = gate();
  const value = { marker: "SECRET" };
  Object.assign(agent, {
    [method]: async () => {
      entered.release();
      await held.promise;
      return value;
    },
  });
  const rows: InferenceStageAudit[] = [];
  installInferenceStages(agent, {
    now: () => 123,
    identity: () => ({ operationId: "op", sessionId: "root" }),
    audit: (row) => {
      rows.push(row);
      return ok(undefined);
    },
    failed: () => expect.fail("audit failure"),
  });
  const pending = (agent[method] as () => Promise<unknown>)();
  await entered.promise;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    edge: "enter",
    observedAt: 123,
    operationId: "op",
    sessionId: "root",
  });
  expect(JSON.stringify(rows)).not.toContain("SECRET");
  held.release();
  expect(await pending).toBe(value);
  expect(rows[1]).toMatchObject({
    edge: "exit",
    stage: rows[0]?.stage,
    sequence: rows[0]?.sequence,
  });
});
