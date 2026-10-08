import { request } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { startInferenceWireProxy } from "./inference-wire-proxy.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("records body arrival separately from held upstream headers and forwards HTTP400 unchanged once", async () => {
  const entered = gate<{ bytes: Buffer; signal: AbortSignal }>();
  const headers = gate<Response>();
  let calls = 0;
  const started = await startInferenceWireProxy("https://fixture.invalid/backend-api", {
    fetch: async (_url, init) => {
      calls++;
      expect(init?.method).toBe("POST");
      entered.resolve({
        bytes: Buffer.from(init?.body as Uint8Array),
        signal: init?.signal as AbortSignal,
      });
      return headers.promise;
    },
    now: () => 123,
  });
  const proxy = started._unsafeUnwrap();
  const bytes = zstdCompressSync(
    Buffer.from(
      JSON.stringify({
        model: "gpt-6.1-sol",
        input: [{ role: "user", content: [{ type: "input_text", text: "PROFILE_CASE_1" }] }],
        instructions: "SECRET",
      }),
    ),
  );
  const pending = ResultAsync.fromPromise(
    fetch(`${proxy.baseUrl}/codex/responses`, {
      method: "POST",
      headers: { "content-encoding": "zstd", authorization: "Bearer SECRET" },
      body: bytes,
    }),
    () => "transport" as const,
  );
  try {
    const upstream = await entered.promise;
    expect(upstream.bytes).toEqual(bytes);
    expect(proxy.snapshot()).toEqual([
      expect.objectContaining({
        sequence: 1,
        enteredAt: 123,
        bodyArrivedAt: 123,
        upstreamEnteredAt: 123,
        headersAt: null,
        firstByteAt: null,
        terminal: null,
        model: "sol",
        marker: "profile_case_1",
        inputCount: 1,
        bodyBytes: bytes.length,
        encoding: "zstd",
        responseBytes: 0,
      }),
    ]);
    headers.resolve(new Response('{"error":"no_matching_rule"}', { status: 400 }));
    const response = (await pending)._unsafeUnwrap();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"no_matching_rule"}');
    await proxy.idle();
    expect(calls).toBe(1);
    expect(proxy.snapshot()[0]).toMatchObject({
      status: 400,
      responseError: "no_matching_rule",
      headersAt: 123,
      firstByteAt: 123,
      terminal: "complete",
    });
    expect(JSON.stringify(proxy.snapshot())).not.toMatch(/SECRET|fixture.invalid/);
  } finally {
    headers.resolve(new Response(""));
    expect((await proxy.close()).isOk()).toBe(true);
  }
});

it("cancels and drains held headers without forwarding another attempt", async () => {
  const entered = gate<AbortSignal>();
  const aborted = gate<void>();
  let calls = 0;
  const proxy = (
    await startInferenceWireProxy("https://fixture.invalid", {
      fetch: async (_url, init) => {
        calls++;
        const signal = init?.signal as AbortSignal;
        entered.resolve(signal);
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new DOMException("SECRET", "AbortError"));
            },
            { once: true },
          ),
        );
      },
    })
  )._unsafeUnwrap();
  const controller = new AbortController();
  const pending = ResultAsync.fromPromise(
    fetch(`${proxy.baseUrl}/codex/responses`, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    }),
    () => "cancelled" as const,
  );
  try {
    await entered.promise;
    controller.abort();
    await aborted.promise;
    expect((await pending).isErr()).toBe(true);
    await proxy.idle();
    expect(calls).toBe(1);
    expect(proxy.snapshot()[0]).toMatchObject({ headersAt: null, terminal: "client_cancelled" });
  } finally {
    await proxy.close();
  }
});

it("distinguishes held stream body from headers and drains it on fixture cleanup", async () => {
  const cancelled = gate<void>();
  const proxy = (
    await startInferenceWireProxy("https://fixture.invalid", {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
  )._unsafeUnwrap();
  const response = await fetch(`${proxy.baseUrl}/codex/responses`, { method: "POST", body: "{}" });
  const reader = response.body?.getReader();
  expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
  expect(proxy.snapshot()[0]).toMatchObject({ status: 200, responseBytes: 13, terminal: null });
  expect(proxy.snapshot()[0]?.headersAt).not.toBeNull();
  expect(proxy.snapshot()[0]?.firstByteAt).not.toBeNull();
  expect((await proxy.close()).isOk()).toBe(true);
  await cancelled.promise;
  await proxy.idle();
  expect(proxy.snapshot()[0]).toMatchObject({ terminal: "fixture_cleanup" });
  await ResultAsync.fromPromise(reader?.cancel() ?? Promise.resolve(), () => "cancelled" as const);
});

it("never starts upstream fetch after a cancelled incomplete inbound body", async () => {
  const entered = gate<void>();
  let calls = 0;
  const proxy = (
    await startInferenceWireProxy("https://fixture.invalid", {
      now: () => {
        entered.resolve();
        return 123;
      },
      fetch: async () => {
        calls++;
        return new Response("");
      },
    })
  )._unsafeUnwrap();
  const client = request(`${proxy.baseUrl}/codex/responses`, {
    method: "POST",
    headers: { "content-length": 100 },
  });
  const closed = new Promise<void>((resolve) => client.once("error", () => resolve()));
  client.flushHeaders();
  await entered.promise;
  client.destroy();
  await closed;
  await proxy.close();
  expect(calls).toBe(0);
  expect(proxy.snapshot()[0]?.bodyArrivedAt).toBeNull();
});
