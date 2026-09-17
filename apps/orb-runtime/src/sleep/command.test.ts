import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSleepArgs, requestSelfSleep } from "./command.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sleep command", () => {
  it.each([
    ["1s", 1],
    ["12m", 720],
    ["3h", 10_800],
    ["2d", 172_800],
  ] as const)("parses %s", (value, durationSeconds) => {
    expect(parseSleepArgs([value])._unsafeUnwrap()).toEqual({ durationSeconds });
  });

  it.each([[[]], [["1"]], [["0s"]], [["-1s"]], [["1.5h"]], [["1w"]], [["1s", "extra"]]])(
    "rejects invalid arguments %j",
    (args) => expect(parseSleepArgs(args).isErr()).toBe(true),
  );

  it("rejects durations that are not safely representable in milliseconds or Date", () => {
    expect(parseSleepArgs([`${Number.MAX_SAFE_INTEGER}d`]).isErr()).toBe(true);
  });

  it("submits exactly once and returns the accepted absolute deadline", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            v: 1,
            sleepId: "11111111-1111-4111-8111-111111111111",
            sleepUntil: "2026-09-18T04:05:06.000Z",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await requestSelfSleep(
      { controlPlaneUrl: "http://control-plane.test", runtimeToken: "secret" },
      { durationSeconds: 3600 },
    );
    expect(result._unsafeUnwrap().sleepUntil).toBe("2026-09-18T04:05:06.000Z");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://control-plane.test/runtime/v1/orb/sleep",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ v: 1, durationSeconds: 3600 }),
      }),
    );
  });

  it("bounds the single request and honestly reports unknown acceptance", async () => {
    const controller = new AbortController();
    expect(vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal));
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("private failure")), {
            once: true,
          });
        }),
    );
    const pending = requestSelfSleep(
      { controlPlaneUrl: "http://control-plane.test", runtimeToken: "secret" },
      { durationSeconds: 1 },
    );
    controller.abort();
    const result = await pending;
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: "unknown_outcome" });
    expect(result._unsafeUnwrapErr().message).toContain("acceptance is unknown");
    expect(result._unsafeUnwrapErr().message).not.toContain("private");
  });
});
