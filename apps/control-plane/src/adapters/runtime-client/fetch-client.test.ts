import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFetchError, FetchRuntimeClient } from "./fetch-client.ts";

const task = new NoSimulationTask("runtime client response evidence", false);

afterEach(() => vi.unstubAllGlobals());

/**
 * undici's rejection shapes (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md):
 * every one of these reads as the bare message "fetch failed" without the walk.
 */
const withCause = (message: string, cause: unknown): Error => {
  const error = new Error(message);
  (error as { cause?: unknown }).cause = cause;
  return error;
};

const coded = (code: string): Error => {
  const error = new Error(code);
  (error as { code?: unknown }).code = code;
  return error;
};

describe("describeFetchError", () => {
  it("unwraps a plain cause with a syscall code", () => {
    expect(describeFetchError(withCause("fetch failed", coded("ECONNREFUSED")))).toBe(
      "fetch failed (ECONNREFUSED)",
    );
    expect(describeFetchError(withCause("fetch failed", coded("EHOSTUNREACH")))).toBe(
      "fetch failed (EHOSTUNREACH)",
    );
  });

  it("takes the first code out of an AggregateError's errors", () => {
    const aggregate = new AggregateError(
      [new Error("no code"), coded("ETIMEDOUT"), coded("ECONNREFUSED")],
      "all attempts failed",
    );
    expect(describeFetchError(withCause("fetch failed", aggregate))).toBe(
      "fetch failed (ETIMEDOUT)",
    );
  });

  it("walks nested causes", () => {
    const nested = withCause("outer", withCause("inner", coded("UND_ERR_CONNECT_TIMEOUT")));
    expect(describeFetchError(nested)).toBe("outer (UND_ERR_CONNECT_TIMEOUT)");
  });

  it("leaves a causeless error alone", () => {
    expect(describeFetchError(new Error("fetch failed"))).toBe("fetch failed");
  });

  it("survives a non-Error cause, a codeless chain, and a thrown non-Error", () => {
    expect(describeFetchError(withCause("fetch failed", "just a string"))).toBe("fetch failed");
    expect(describeFetchError(withCause("fetch failed", null))).toBe("fetch failed");
    expect(describeFetchError(withCause("fetch failed", { nothing: true }))).toBe("fetch failed");
    expect(describeFetchError("not an error at all")).toBe("not an error at all");
  });

  it("ignores a numeric code (DOMException) and finds the real one deeper", () => {
    const domLike = { code: 20, cause: coded("ECONNRESET") };
    expect(describeFetchError(withCause("The operation was aborted", domLike))).toBe(
      "The operation was aborted (ECONNRESET)",
    );
  });

  it("terminates on a self-referential cause chain", () => {
    const looping = new Error("fetch failed");
    (looping as { cause?: unknown }).cause = looping;
    expect(describeFetchError(looping)).toBe("fetch failed");
  });
});

describe("FetchRuntimeClient response evidence", () => {
  it.each([
    undefined,
    { kind: "sleep_wake" as const, sleepUntil: "2026-10-08T00:00:00.000Z" },
    { kind: "sleep_expired" as const, sleepUntil: "2026-10-08T00:00:00.000Z" },
  ])("preserves inbox provenance over HTTP: %j", async (system) => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          v: 1,
          messageId: "notice-1",
          status: "queued",
          delivery: "turn",
          operationId: "operation-1",
          duplicate: false,
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const content = [{ type: "text" as const, text: "Scheduled sleep finished." }];
    const result = await new FetchRuntimeClient().deliverMessage(
      task,
      {
        baseUrl: "http://runtime.test",
        messageId: "notice-1",
        messageIds: ["notice-1"],
        content,
        ...(system === undefined ? {} : { system }),
      },
      { signal: new AbortController().signal },
    );
    expect(result.isOk()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://runtime.test/v1/messages/notice-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          v: 1,
          messageId: "notice-1",
          messageIds: ["notice-1"],
          content,
          ...(system === undefined ? {} : { system }),
        }),
      }),
    );
  });
  it("addresses a multi-message batch by its first message id", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          v: 1,
          messageId: "first",
          status: "queued",
          delivery: "turn",
          operationId: "operation-1",
          duplicate: false,
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const content = [{ type: "text" as const, text: "one\n\ntwo" }];
    const result = await new FetchRuntimeClient().deliverMessage(
      task,
      {
        baseUrl: "http://runtime.test",
        messageId: "hashed-batch-id",
        messageIds: ["first", "second"],
        content,
      },
      { signal: new AbortController().signal },
    );
    expect(result.isOk()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://runtime.test/v1/messages/first",
      expect.objectContaining({
        body: JSON.stringify({
          v: 1,
          messageId: "first",
          messageIds: ["first", "second"],
          content,
        }),
      }),
    );
  });
  it("binds detail and binary image reads to the requested session", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/images/")
        ? new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } })
        : Response.json({
            v: 1,
            sessionId: "session",
            recordId: "record",
            detailKey: "record:0",
            state: "committed",
            body: { type: "reasoning", text: "detail" },
          }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new FetchRuntimeClient();
    const context = { signal: new AbortController().signal };
    expect(
      (
        await client.readDisplayDetail(
          task,
          "http://runtime.test",
          "session",
          "record",
          "record:0",
          context,
        )
      ).isOk(),
    ).toBe(true);
    const image = await client.readDisplayImage(
      task,
      "http://runtime.test",
      "session",
      "record",
      "record:0",
      0,
      context,
    );
    expect(image.isOk()).toBe(true);
    if (image.isOk()) {
      expect(image.value.mediaType).toBe("image/png");
      expect(image.value.data).toEqual(Buffer.from("image"));
    }
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("sessionId"))).toEqual([
      "session",
      "session",
    ]);
  });
  it.each([true, false])("validates idle-stop admission response %s", async (prepared) => {
    const fetch = vi.fn(async () => Response.json({ v: 1, prepared }));
    vi.stubGlobal("fetch", fetch);
    const result = await new FetchRuntimeClient().prepareIdleStop(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result._unsafeUnwrap()).toEqual({ v: 1, prepared });
    expect(fetch).toHaveBeenCalledWith(
      "http://runtime.test/v1/prepare-idle-stop",
      expect.objectContaining({
        method: "POST",
        body: '{"v":1}',
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("does not mistake a malformed idle-stop response for permission to stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ v: 1, prepared: "true" })),
    );
    const result = await new FetchRuntimeClient().prepareIdleStop(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      code: "invalid_response",
      answered: true,
    });
  });
  it("marks an HTTP error as answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "busy" } }, { status: 503 })),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: true,
      code: "http_error",
    });
  });

  it.each([
    ["unparseable JSON", new Response("{", { status: 200 })],
    ["invalid schema", Response.json({}, { status: 200 })],
  ])("marks %s after a response as answered", async (_case, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: true,
      code: "invalid_response",
    });
  });

  it("marks a network failure as unanswered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: false,
      code: "unreachable",
    });
  });

  it("marks a pre-aborted request as unanswered cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: controller.signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: false,
      code: "cancelled",
    });
  });
});

async function withLoopback(
  respond: (response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((_request, response) => respond(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function pullHistory(baseUrl: string, signal = new AbortController().signal) {
  return new FetchRuntimeClient().pullHistory(
    task,
    { baseUrl, after: null, limit: 10 },
    { signal },
  );
}

/** Observe native fetch/body consumption without replacing either operation. */
function bodyReadGate(): Promise<void> {
  const nativeFetch = globalThis.fetch;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args);
    for (const method of ["json", "text"] as const) {
      const read = response[method].bind(response);
      Object.defineProperty(response, method, {
        value: () => {
          const pending = read();
          resolveStarted();
          return pending;
        },
      });
    }
    return response;
  });
  return started;
}

describe("FetchRuntimeClient loopback body failures", () => {
  it("classifies abort after headers during a held body as retryable cancellation", async () => {
    const bodyStarted = bodyReadGate();
    const controller = new AbortController();
    await withLoopback(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      },
      async (baseUrl) => {
        const pending = pullHistory(baseUrl, controller.signal);
        await bodyStarted;
        controller.abort();
        expect((await pending)._unsafeUnwrapErr()).toMatchObject({
          code: "cancelled",
          retryable: true,
          answered: false,
          message: expect.stringContaining("body read cancelled"),
        });
      },
    );
  });

  it("classifies socket interruption after headers during a held body as retryable transport failure", async () => {
    const bodyStarted = bodyReadGate();
    let heldResponse!: ServerResponse;
    await withLoopback(
      (response) => {
        heldResponse = response;
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      },
      async (baseUrl) => {
        const pending = pullHistory(baseUrl);
        await bodyStarted;
        heldResponse.destroy();
        expect((await pending)._unsafeUnwrapErr()).toMatchObject({
          code: "unreachable",
          retryable: true,
          answered: false,
          message: expect.stringContaining("UND_ERR_SOCKET"),
        });
      },
    );
  });

  it.each([201, 202, 400, 503])(
    "preserves HTTP %s classification for a complete non-JSON history response",
    async (status) => {
      await withLoopback(
        (response) => response.writeHead(status).end("upstream unavailable"),
        async (baseUrl) => {
          expect((await pullHistory(baseUrl))._unsafeUnwrapErr()).toMatchObject({
            code: "http_error",
            retryable: status >= 500,
            answered: true,
            message: `runtime returned HTTP ${status}`,
          });
        },
      );
    },
  );

  it.each([
    ["cursor_not_found", 409, false],
    ["history_unavailable", 503, true],
  ] as const)("preserves structured %s errors", async (code, status, retryable) => {
    await withLoopback(
      (response) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ v: 1, error: { code, message: "runtime error", retryable } })),
      async (baseUrl) => {
        expect((await pullHistory(baseUrl))._unsafeUnwrapErr()).toMatchObject({
          code,
          retryable,
          answered: true,
          message: "runtime error",
        });
      },
    );
  });

  it.each([
    ["unparseable JSON", "private-body"],
    ["invalid schema", "{}"],
  ])("keeps complete 200 %s as an integrity failure without body contents", async (_case, body) => {
    await withLoopback(
      (response) => response.writeHead(200, { "content-type": "application/json" }).end(body),
      async (baseUrl) => {
        const error = (await pullHistory(baseUrl))._unsafeUnwrapErr();
        expect(error).toMatchObject({
          code: "invalid_response",
          retryable: false,
          answered: true,
        });
        expect(error.message).not.toContain("private-body");
      },
    );
  });

  it("keeps malformed accepted 202 message responses as integrity failures", async () => {
    await withLoopback(
      (response) => response.writeHead(202).end("{"),
      async (baseUrl) => {
        const result = await new FetchRuntimeClient().deliverMessage(
          task,
          { baseUrl, messageId: "message", messageIds: ["message"], content: [] },
          { signal: new AbortController().signal },
        );
        expect(result._unsafeUnwrapErr()).toMatchObject({
          code: "invalid_response",
          retryable: false,
          answered: true,
        });
      },
    );
  });
});
