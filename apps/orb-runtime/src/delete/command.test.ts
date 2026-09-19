import { afterEach, expect, it, vi } from "vitest";
import { requestSelfDelete } from "./command.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("bounds the request and reports an unknown outcome when its deadline aborts", async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new Error("transport timeout with sensitive details")),
          { once: true },
        );
      }),
  );
  const pending = requestSelfDelete({
    controlPlaneUrl: "http://control-plane.test",
    runtimeToken: "private-token",
  });
  expect(timeout).toHaveBeenCalledWith(3_000);
  controller.abort();
  const result = await pending;
  expect(result.isErr() && result.error.code).toBe("unknown_outcome");
  expect(result.isErr() && result.error.message).not.toContain("sensitive");
  expect(result.isErr() && result.error.message).not.toContain("private-token");
});

const env = { controlPlaneUrl: "http://control-plane.test", runtimeToken: "private-token" };

it("submits once and returns on acceptance without waiting for idle or completion", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ orbId: "self", state: "deleting" }), { status: 202 }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await requestSelfDelete(env);
  expect(result.isOk() && result.value).toEqual({ orbId: "self", state: "deleting" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("http://control-plane.test/runtime/v1/orb/delete", {
    method: "POST",
    headers: { authorization: "Bearer private-token", "content-type": "application/json" },
    body: "{}",
    signal: expect.any(AbortSignal),
  });
});

it.each([
  [200, { orbId: "self", state: "deleting" }],
  [202, { orbId: "self", state: "running" }],
  [500, { error: { code: "unknown", message: "private-token" } }],
  [401, { error: "private-token" }],
])("does not trust an invalid response (%i)", async (status, payload) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status })),
  );
  const result = await requestSelfDelete(env);
  expect(result.isErr() && result.error.code).toBe("unknown_outcome");
  expect(result.isErr() && result.error.message).not.toContain("private-token");
});

it("sanitizes a non-JSON response without claiming rejection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("private-token sensitive failure", { status: 502 })),
  );
  const result = await requestSelfDelete(env);
  expect(result.isErr() && result.error.code).toBe("unknown_outcome");
  expect(result.isErr() && result.error.message).not.toContain("private-token");
});

it("keeps the deadline active while reading the response body", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  let readingBody!: () => void;
  const reading = new Promise<void>((resolve) => {
    readingBody = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status: 202,
      json: () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("private-token")), {
            once: true,
          });
          readingBody();
        }),
    }),
  );
  const pending = requestSelfDelete(env);
  await reading;
  controller.abort();
  const result = await pending;
  expect(result.isErr() && result.error.code).toBe("unknown_outcome");
  expect(result.isErr() && result.error.message).not.toContain("private-token");
});
