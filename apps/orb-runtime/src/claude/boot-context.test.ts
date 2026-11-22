import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBootContext } from "./boot-context.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const broker = { controlPlaneUrl: "http://control-plane.test", runtimeToken: "secret" };

describe("boot context client", () => {
  it("reads sleep context through the authenticated adapter without acknowledging it", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            v: 1,
            userTimeZone: "Asia/Tokyo",
            context: {
              messageId: "sleep-1",
              messageIds: ["sleep-1"],
              content: [{ type: "text", text: "Sleep ended at its scheduled deadline." }],
              system: { kind: "sleep_wake", sleepUntil: "2026-09-18T04:05:06.000Z" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await fetchBootContext(broker))._unsafeUnwrap()).toMatchObject({
      userTimeZone: "Asia/Tokyo",
      context: { messageId: "sleep-1", system: { kind: "sleep_wake" } },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://control-plane.test/runtime/v1/orb/boot-context",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ v: 1 }),
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
  });

  it("reads time zone and model intent without a sleep-wake context", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            v: 1,
            context: null,
            initialModel: { provider: "claude", id: "sonnet" },
            userTimeZone: "Europe/Paris",
          }),
          {
            status: 200,
          },
        ),
    );
    expect((await fetchBootContext(broker))._unsafeUnwrap()).toEqual({
      v: 1,
      context: null,
      initialModel: { provider: "claude", id: "sonnet" },
      userTimeZone: "Europe/Paris",
    });
  });

  it("recovers from retryable failures with bounded 1/2/4-second backoff", async () => {
    let attempts = 0;
    let now = 0;
    const delays: number[] = [];
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      if (attempts < 5) {
        return new Response(
          JSON.stringify({
            error: { code: "unavailable", message: "warming", retryable: true },
          }),
          { status: 503 },
        );
      }
      return new Response(JSON.stringify({ v: 1, context: null, userTimeZone: null }), {
        status: 200,
      });
    });

    const result = await fetchBootContext(broker, {
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });

    expect(result._unsafeUnwrap()).toEqual({ v: 1, context: null, userTimeZone: null });
    expect(attempts).toBe(5);
    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
  });

  it("does not retry a permanent response failure", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "identity rejected", retryable: false },
          }),
          { status: 401 },
        ),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    vi.stubGlobal("fetch", fetch);

    const result = await fetchBootContext(broker, { now: () => 0, sleep });

    expect(result._unsafeUnwrapErr()).toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns the last retryable failure when the retry window is exhausted", async () => {
    let now = 0;
    const delays: number[] = [];
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "unavailable", message: "still warming", retryable: true },
          }),
          { status: 503 },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await fetchBootContext(broker, {
      retryWindowMs: 5_000,
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({
      retryable: true,
      message: "boot context is unavailable: still warming",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000, 2_000]);
  });

  it("does not admit another request when sleep advances past the retry deadline", async () => {
    let now = 0;
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "unavailable", message: "still warming", retryable: true },
          }),
          { status: 503 },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await fetchBootContext(broker, {
      retryWindowMs: 500,
      now: () => now,
      sleep: async () => {
        now = 750;
      },
    });

    expect(result._unsafeUnwrapErr().message).toBe("boot context is unavailable: still warming");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => {
      throw new TypeError("network down");
    },
    () => Promise.reject(new DOMException("request timed out", "TimeoutError")),
  ])("gives each retry attempt its full timeout even near the retry deadline", async (fail) => {
    let now = 0;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => Response.json({ v: 1, context: null, userTimeZone: null }));
    fetch.mockImplementationOnce(fail);
    vi.stubGlobal("fetch", fetch);

    const result = await fetchBootContext(broker, {
      retryWindowMs: 500,
      now: () => now,
      sleep: async () => {
        now = 499;
      },
    });
    expect(result.isOk()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
  });

  it.each([
    ["schema-invalid JSON", JSON.stringify({ v: 1 })],
    ["malformed JSON", "{"],
  ])("fails closed without retry on %s", async (_kind, body) => {
    let now = 0;
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchBootContext(broker, {
      retryWindowMs: 500,
      now: () => now,
      sleep,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "boot_request_error",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
