import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { createDurableTools } from "./index.ts";
import { McpTools } from "./mcp.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([{ name: "Datadog" }, { name: "metrics", description: "Datadog" }])(
  "seeds pending provider search and empty namespace inventory before connecting: $name",
  async (endpoint) => {
    let connections = 0;
    const tools = createDurableTools({
      mcp: [
        {
          ...endpoint,
          connect: () => {
            connections++;
            return errAsync({ code: "unavailable" as const, message: "PRIVATE" });
          },
        },
      ],
    });
    const fixture = await openCodemodeHarness(tools.catalog);
    try {
      const result = await fixture.run(
        `text(await searchTools("Datadog")); text(await describeNamespace("mcp__${endpoint.name}"));`,
      );
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.output)).toContain("mcp_status");
      expect(JSON.stringify(result.output)).toContain("pending");
      expect(JSON.stringify(result.output)).toContain(`mcp__${endpoint.name}`);
      expect(connections).toBe(0);
    } finally {
      await fixture.close();
      await tools.close();
    }
  },
);

it.each(["success", "failure"] as const)(
  "shares discovery with status retry and joins notifications despite cleanup %s",
  async (cleanup) => {
    const entered = barrier(),
      release = barrier(),
      notified = barrier(),
      finishNotification = barrier();
    const abort = new AbortController();
    let connects = 0;
    const statuses: string[] = [];
    const tools = createDurableTools({
      mcpContext: withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
      mcpChanged: (status) => {
        statuses.push(status.status);
        notified.resolve();
        return ResultAsync.fromSafePromise(finishNotification.promise);
      },
      mcp: [
        {
          name: "held",
          connect: () => {
            connects++;
            const { client, server } = createInMemoryTransportPair();
            server.onMessage(async (message) => {
              if (!("method" in message) || !("id" in message)) return;
              entered.resolve();
              await release.promise;
              await server.send({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: "PRIVATE" },
              });
            });
            void server.start();
            return okAsync(client);
          },
        },
      ],
    });
    let closed = false;
    try {
      const first = tools.ready();
      await entered.promise;
      const second = tools.ready();
      const status = tools.catalog.invoke(
        "mcp_status",
        {},
        { diagnostic: () => {} } as unknown as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      expect(JSON.stringify((await status)._unsafeUnwrap())).toContain("pending");
      release.resolve();
      await notified.promise;
      const closeBoundary =
        cleanup === "failure"
          ? vi
              .spyOn(McpTools.prototype, "close")
              .mockReturnValueOnce(errAsync({ code: "unavailable", message: "cleanup failed" }))
          : undefined;
      const closing = (async () => {
        const result = await tools.close();
        closed = true;
        return result;
      })();
      closeBoundary?.mockRestore();
      expect(closed).toBe(false);
      expect(connects).toBe(1);
      finishNotification.resolve();
      expect((await first).isOk()).toBe(true);
      expect((await second).isOk()).toBe(true);
      expect((await status).isOk()).toBe(true);
      expect((await closing).isOk()).toBe(cleanup === "success");
      expect(closed).toBe(true);
      expect(statuses).toEqual(["unavailable"]);
    } finally {
      abort.abort();
      release.resolve();
      finishNotification.resolve();
      await tools.close();
    }
  },
);

it("refreshes a model request prepared before discovery completed without injecting user input", async () => {
  const prepared = barrier(),
    continueRequest = barrier();
  const tools = createDurableTools({
    mcp: [
      {
        name: "fixture",
        connect: () => errAsync({ code: "unavailable" as const, message: "PRIVATE" }),
      },
    ],
  });
  const registry = createRegistry();
  registry.install({
    name: "hold-request",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async () => {
          prepared.resolve();
          await continueRequest.promise;
        },
      }),
    ],
  });
  registry.install(tools.extension);
  const faux = fauxProvider();
  const requests: string[] = [];
  faux.setResponses([
    (request) => {
      requests.push(JSON.stringify(request));
      return fauxAssistantMessage("done");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    harness.resume();
    const submission = await root.submit(
      { type: "input", content: "original" },
      BACKGROUND_CONTEXT,
    );
    await prepared.promise;
    expect((await tools.ready()).isOk()).toBe(true);
    continueRequest.resolve();
    await submission.wait(BACKGROUND_CONTEXT);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("MCP fixture: unavailable.");
    expect(requests[0]).not.toContain("PRIVATE");
    const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
  } finally {
    continueRequest.resolve();
    await harness.close(BACKGROUND_CONTEXT);
    await tools.close();
  }
});

it("contains SDK discovery rejection and permits retry", async () => {
  const tools = createDurableTools();
  const sdk = vi.spyOn(McpTools.prototype, "discover").mockRejectedValueOnce(new Error("PRIVATE"));
  try {
    expect(await tools.ready()).toMatchObject({
      error: { code: "unavailable", message: "MCP discovery failed" },
    });
    expect((await tools.ready()).isOk()).toBe(true);
    expect(sdk).toHaveBeenCalledTimes(2);
  } finally {
    sdk.mockRestore();
    await tools.close();
  }
});

it("returns cached failure while a consent retry outlives the invoking script", async () => {
  const entered = barrier(),
    release = barrier();
  const owner = new AbortController(),
    script = new AbortController();
  let connections = 0;
  const tools = createDurableTools({
    mcpContext: withAbortSignal(owner.signal, BACKGROUND_CONTEXT),
    mcp: [
      {
        name: "fixture",
        connect: (ctx) => {
          connections++;
          if (connections === 1)
            return errAsync({ code: "unavailable" as const, message: "PRIVATE" });
          expect(ctx.abortSignal).toBe(owner.signal);
          entered.resolve();
          return ResultAsync.fromSafePromise(release.promise).andThen(() =>
            errAsync({ code: "unavailable" as const, message: "PRIVATE" }),
          );
        },
      },
    ],
  });
  try {
    expect((await tools.ready()).isOk()).toBe(true);
    const status = await tools.catalog.invoke(
      "mcp_status",
      {},
      { diagnostic: () => {} } as unknown as ToolExecutionApi,
      withAbortSignal(script.signal, BACKGROUND_CONTEXT),
    );
    expect(JSON.stringify(status)).toContain("unavailable");
    await entered.promise;
    script.abort();
    expect(owner.signal.aborted).toBe(false);
    const joined = tools.ready();
    release.resolve();
    expect((await joined).isOk()).toBe(true);
    expect(connections).toBe(2);
  } finally {
    release.resolve();
    await tools.close();
  }
});
