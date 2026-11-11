import { afterEach, expect, it, vi } from "vitest";
import { parseDeleteArgs, requestDelete } from "./command.ts";

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
  const pending = requestDelete(
    {
      controlPlaneUrl: "http://control-plane.test",
      runtimeToken: "private-token",
    },
    { self: true },
  );
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
  const result = await requestDelete(env, { self: true });
  expect(result.isOk() && result.value).toEqual({ orbId: "self", state: "deleting" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("http://control-plane.test/runtime/v1/orb/delete", {
    method: "POST",
    headers: { authorization: "Bearer private-token", "content-type": "application/json" },
    body: JSON.stringify({ self: true }),
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
  const result = await requestDelete(env, { self: true });
  expect(result.isErr() && result.error.code).toBe("unknown_outcome");
  expect(result.isErr() && result.error.message).not.toContain("private-token");
});

it("sanitizes a non-JSON response without claiming rejection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("private-token sensitive failure", { status: 502 })),
  );
  const result = await requestDelete(env, { self: true });
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
  const pending = requestDelete(env, { self: true });
  await reading;
  controller.abort();
  const result = await pending;
  expect(result.isErr() && result.error.code).toBe("unknown_outcome");
  expect(result.isErr() && result.error.message).not.toContain("private-token");
});

const orbId = "123e4567-e89b-42d3-a456-426614174000";

it("requires an explicit self or full UUID target and normalizes UUID case", () => {
  expect(parseDeleteArgs(["self"])._unsafeUnwrap()).toEqual({ self: true });
  expect(parseDeleteArgs([orbId.toUpperCase()])._unsafeUnwrap()).toEqual({ orbId });
  for (const args of [
    [],
    ["child"],
    ["123e4567"],
    ["SELF"],
    [""],
    ["--yes"],
    ["self", "--force"],
    [orbId, "--recursive"],
    ["self", orbId],
    ["self", "--json"],
  ]) {
    expect(parseDeleteArgs(args).isErr(), JSON.stringify(args)).toBe(true);
  }
});

it("submits the explicit UUID without resolving a name", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ orbId, state: "deleting" }), { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  expect((await requestDelete(env, { orbId })).isOk()).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "http://control-plane.test/runtime/v1/orb/delete",
    expect.objectContaining({ body: JSON.stringify({ orbId }) }),
  );
});

it.each([{ self: true } as const, { orbId }])(
  "identifies the target after unknown acceptance: %j",
  async (target) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-token")));
    const result = await requestDelete(env, target);
    expect(result.isErr() && result.error.message).toContain("self" in target ? "this orb" : orbId);
    expect(result.isErr() && result.error.message).not.toContain("private-token");
  },
);

it("preserves the backend instruction to use self for an explicit own ID", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "invalid_request", message: "use pi-orb delete self", retryable: false },
        }),
        { status: 400 },
      ),
    ),
  );
  const result = await requestDelete(env, { orbId });
  expect(result.isErr() && result.error.message).toBe("use pi-orb delete self");
});
