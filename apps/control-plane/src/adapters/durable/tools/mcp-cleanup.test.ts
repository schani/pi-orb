import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { McpTools } from "./mcp.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const entered = barrier(),
    deleting = barrier(),
    release = barrier();
  let calls = 0,
    deletes = 0,
    closed = 0;
  let callSignal: AbortSignal | undefined;
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools(
    [
      {
        name: "fixture",
        connect: () => {
          const transport = new StreamableHTTPClientTransport(
            new URL("https://fixture.invalid/mcp"),
            {
              fetch: async (_url, init) => {
                if (init?.method === "DELETE") {
                  deletes++;
                  if (deletes > 1) {
                    deleting.resolve();
                    await release.promise;
                  }
                  return new Response(null, { status: 204 });
                }
                if (init?.method === "GET") return new Response(null, { status: 405 });
                const { id, method } = JSON.parse(String(init?.body));
                if (method === "server/discover")
                  return Response.json({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: "Unsupported" },
                  });
                if (method === "initialize")
                  return Response.json(
                    {
                      jsonrpc: "2.0",
                      id,
                      result: {
                        protocolVersion: "2025-11-25",
                        capabilities: { tools: {} },
                        serverInfo: { name: "fixture", version: "1" },
                      },
                    },
                    { headers: { "mcp-session-id": "session" } },
                  );
                if (method === "notifications/initialized" || method === "notifications/cancelled")
                  return new Response(null, { status: 202 });
                if (method === "tools/list")
                  return Response.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                      tools: [{ name: "wait", inputSchema: { type: "object" } }],
                    },
                  });
                expect(method).toBe("tools/call");
                calls++;
                callSignal = init?.signal ?? undefined;
                entered.resolve();
                return new Promise<Response>((_resolve, reject) => {
                  const abort = () => reject(new DOMException("Aborted SECRET", "AbortError"));
                  if (callSignal?.aborted) abort();
                  else callSignal?.addEventListener("abort", abort, { once: true });
                });
              },
            },
          );
          const close = transport.close.bind(transport);
          transport.close = async () => {
            closed++;
            await close();
          };
          return okAsync(transport);
        },
      },
    ],
    catalog,
  );
  return {
    mcp,
    catalog,
    entered,
    deleting,
    release,
    state: () => ({ calls, deletes, closed, aborted: callSignal?.aborted }),
  };
}

it.each(["cancel", "root"] as const)(
  "joins session termination before transport close on %s cancellation",
  async (kind) => {
    const f = fixture(),
      scope = withCancel(BACKGROUND_CONTEXT);
    try {
      (await f.mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      const call = f.catalog.invoke(
        "mcp__fixture__wait",
        {},
        {} as ToolExecutionApi,
        scope.context,
      );
      await f.entered.promise;
      const closing = kind === "root" ? f.mcp.close() : undefined;
      if (kind === "cancel") scope.cancel();
      await f.deleting.promise;
      expect(f.state()).toEqual({ calls: 1, deletes: 2, closed: 1, aborted: true });
      let completed = false;
      const joined = call.map((result) => {
        completed = true;
        return result;
      });
      expect(completed).toBe(false);
      f.release.resolve();
      const result = (await joined)._unsafeUnwrap();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET");
      if (closing) (await closing)._unsafeUnwrap();
      expect(f.state()).toEqual({ calls: 1, deletes: 2, closed: 2, aborted: true });
    } finally {
      f.release.resolve();
      scope.cancel();
      await f.mcp.close();
    }
  },
);

it("aborts timed-out requests before bounded session termination and always closes", async () => {
  const f = fixture();
  try {
    (await f.mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    vi.useFakeTimers();
    const call = f.catalog.invoke(
      "mcp__fixture__wait",
      {},
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    await f.entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await f.deleting.promise;
    expect(f.state()).toEqual({ calls: 1, deletes: 2, closed: 1, aborted: true });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = (await call)._unsafeUnwrap();
    expect(result.isError).toBe(true);
    expect(f.state()).toEqual({ calls: 1, deletes: 2, closed: 2, aborted: true });
  } finally {
    f.release.resolve();
    vi.useRealTimers();
    await f.mcp.close();
  }
});
