import { createServer } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { zstdCompressSync } from "node:zlib";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { durableFakeRelay, rejectUpgrade } from "./durable-fake-relay.ts";

it("records original compressed requests and bridges raw source and JSON fallback over real HTTP", async () => {
  const bodies: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "codemode" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"code":' },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: JSON.stringify({ code: "text('RAW')" }),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "codemode",
          arguments: JSON.stringify({ code: "text('RAW')" }),
        },
      },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ];
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const relay = await durableFakeRelay(`http://127.0.0.1:${address.port}/backend-api`);
  try {
    const rawBody = {
      tools: [{ type: "custom", name: "codemode" }],
      input: [{ type: "custom_tool_call_output", call_id: "prior", output: "READY" }],
    };
    const raw = await fetch(`${relay.baseUrl}/codex/responses`, {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body: zstdCompressSync(Buffer.from(JSON.stringify(rawBody))),
    });
    const result = await raw.text();
    expect(result).toContain('"type":"custom_tool_call"');
    expect(result).toContain('"input":"text(\'RAW\')"');
    expect(result).not.toContain("function_call_arguments");
    expect(relay.requests[0]).toEqual(rawBody);
    expect(bodies[0]).toEqual({
      ...rawBody,
      input: [{ ...rawBody.input[0], type: "function_call_output" }],
    });
    const json = await fetch(`${relay.baseUrl}/codex/responses`, {
      method: "POST",
      body: JSON.stringify({ tools: [{ type: "function", name: "codemode" }] }),
    });
    expect(await json.text()).toContain("response.function_call_arguments.delta");
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it.for(["reset", "graceful"] as const)(
  "owns a rejected WebSocket upgrade through peer %s and relay close",
  async (peerClose, { signal }) => {
    const ioFailure = (cause: unknown) => ({
      type: "fixture_io" as const,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    const relay = (
      await ResultAsync.fromThrowable(durableFakeRelay, ioFailure)("http://127.0.0.1:1/backend-api")
    )._unsafeUnwrap();
    const client = new Socket();
    const errors: ReturnType<typeof ioFailure>[] = [];
    const closed = new Promise<boolean>((resolve) => client.once("close", resolve));
    let buffered = "";
    const headers = new Promise<
      Result<
        string,
        ReturnType<typeof ioFailure> | { type: "headers_too_large" | "closed_before_headers" }
      >
    >((resolve) => {
      client.on("error", (cause) => {
        const failure = ioFailure(cause);
        errors.push(failure);
        resolve(err(failure));
      });
      client.once("close", () => resolve(err({ type: "closed_before_headers" })));
      client.on("data", (chunk: Buffer) => {
        if (buffered.length + chunk.length > 4096) {
          resolve(err({ type: "headers_too_large" }));
          return;
        }
        buffered += chunk.toString("latin1");
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary !== -1) resolve(ok(buffered.slice(0, boundary + 4)));
      });
    });
    const abort = () => client.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const address = new URL(relay.baseUrl);
      Result.fromThrowable(() => {
        client.connect(Number(address.port), address.hostname);
        client.write(
          `GET ${address.pathname}/codex/responses HTTP/1.1\r\n` +
            `Host: ${address.host}\r\n` +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      }, ioFailure)()._unsafeUnwrap();
      expect((await headers)._unsafeUnwrap()).toBe(
        "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      Result.fromThrowable(() => {
        if (peerClose === "reset") client.resetAndDestroy();
        else client.end();
      }, ioFailure)()._unsafeUnwrap();
      expect(await closed).toBe(false);
      expect(client.destroyed).toBe(true);
      expect(errors).toEqual([]);
      expect(relay.requests).toEqual([]);
      expect(relay.check).not.toThrow();
    } finally {
      client.destroy();
      await closed;
      signal.removeEventListener("abort", abort);
      (await ResultAsync.fromThrowable(relay.close, ioFailure)())._unsafeUnwrap();
    }
  },
);

it("closes and joins a rejected upgrade while the peer keeps its write side open", async ({
  signal,
}) => {
  const ioFailure = (cause: unknown) => ({
    type: "fixture_io" as const,
    message: cause instanceof Error ? cause.message : String(cause),
  });
  const relay = (
    await ResultAsync.fromThrowable(durableFakeRelay, ioFailure)("http://127.0.0.1:1/backend-api")
  )._unsafeUnwrap();
  const client = new Socket({ allowHalfOpen: true });
  const errors: ReturnType<typeof ioFailure>[] = [];
  let peerClosed = false;
  const closed = new Promise<boolean>((resolve) =>
    client.once("close", (hadError) => {
      peerClosed = true;
      resolve(hadError);
    }),
  );
  let buffered = "";
  const response = new Promise<
    Result<string, ReturnType<typeof ioFailure> | { type: "incomplete_response" }>
  >((resolve) => {
    client.on("error", (cause) => {
      const failure = ioFailure(cause);
      errors.push(failure);
      resolve(err(failure));
    });
    client.once("close", () => resolve(err({ type: "incomplete_response" })));
    client.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      if (buffered.length > 4096) resolve(err({ type: "incomplete_response" }));
    });
    client.once("end", () => resolve(ok(buffered)));
  });
  const abort = () => client.destroy();
  signal.addEventListener("abort", abort, { once: true });
  let closing: Promise<void> | undefined;
  try {
    const address = new URL(relay.baseUrl);
    Result.fromThrowable(() => {
      client.connect(Number(address.port), address.hostname);
      client.write(
        `GET ${address.pathname}/codex/responses HTTP/1.1\r\n` +
          `Host: ${address.host}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    }, ioFailure)()._unsafeUnwrap();
    expect((await response)._unsafeUnwrap()).toBe(
      "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    expect(peerClosed).toBe(false);
    expect(client.writableEnded).toBe(false);
    closing = relay.close();
    (await ResultAsync.fromPromise(closing, ioFailure))._unsafeUnwrap();
    Result.fromThrowable(() => client.end(), ioFailure)()._unsafeUnwrap();
    expect(await closed).toBe(false);
    expect(errors).toEqual([]);
    expect(relay.requests).toEqual([]);
    expect(relay.check).not.toThrow();
  } finally {
    client.destroy();
    await closed;
    signal.removeEventListener("abort", abort);
    (await ResultAsync.fromPromise(closing ?? relay.close(), ioFailure))._unsafeUnwrap();
  }
});

it("retains an unexpected upgrade stream fault until actual close", async () => {
  let finishDestroy: ((error?: Error | null) => void) | undefined;
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
    destroy(_error, callback) {
      finishDestroy = callback;
    },
  });
  const completed = rejectUpgrade(socket);
  let settled = false;
  const joined = completed
    .map((outcome) => {
      settled = true;
      return outcome;
    })
    .mapErr((failure) => {
      settled = true;
      return failure;
    });
  const fault = Object.assign(new Error("controlled upgrade read fault"), {
    code: "EIO",
    syscall: "read",
  });
  try {
    socket.destroy(fault);
    expect(finishDestroy).toBeTypeOf("function");
    expect(settled).toBe(false);
  } finally {
    finishDestroy?.(fault);
    await joined;
  }
  const result = await joined;
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error).toEqual({
      type: "upgrade_socket_failure",
      operation: "stream",
      code: "EIO",
      syscall: "read",
      message: "controlled upgrade read fault",
    });
  expect(socket.closed).toBe(true);
});
