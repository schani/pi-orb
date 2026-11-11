import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArchiveArgs, requestArchive } from "../archive/command.ts";
import { parseDeleteArgs, requestDelete } from "./command.ts";

const env = { controlPlaneUrl: "http://control-plane.test", runtimeToken: "private-token" };
const orbId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { action: "delete", state: "deleting", parse: parseDeleteArgs, request: requestDelete },
  { action: "archive", state: "archiving", parse: parseArchiveArgs, request: requestArchive },
])("pi-orb $action command", ({ action, state, parse, request }) => {
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
    const pending = request(env, { orbId });
    expect(timeout).toHaveBeenCalledWith(3_000);
    controller.abort();
    const result = await pending;
    expect(result.isErr() && result.error.code).toBe("unknown_outcome");
    expect(result.isErr() && result.error.message).toContain(orbId);
    expect(result.isErr() && result.error.message).not.toContain("sensitive");
    expect(result.isErr() && result.error.message).not.toContain("private-token");
  });

  it("submits once and returns on acceptance without waiting for idle or completion", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ orbId, state }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const result = await request(env, { orbId });
    expect(result.isOk() && result.value).toEqual({ orbId, state });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`http://control-plane.test/runtime/v1/orb/${action}`, {
      method: "POST",
      headers: { authorization: "Bearer private-token", "content-type": "application/json" },
      body: JSON.stringify({ orbId }),
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    [200, { orbId: "self", state: "deleting" }],
    [202, { orbId: "self", state: "running" }],
    [202, { orbId: "self", state: state === "deleting" ? "archiving" : "deleting" }],
    [202, { orbId: "self", state, extra: true }],
    [500, { error: { code: "unknown", message: "private-token" } }],
    [401, { error: "private-token" }],
  ])("does not trust an invalid response (%i)", async (status, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status })),
    );
    const result = await request(env, { self: true });
    expect(result.isErr() && result.error.code).toBe("unknown_outcome");
    expect(result.isErr() && result.error.message).not.toContain("private-token");
  });

  it("sanitizes a non-JSON response without claiming rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private-token sensitive failure", { status: 502 })),
    );
    const result = await request(env, { self: true });
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
    const pending = request(env, { self: true });
    await reading;
    controller.abort();
    const result = await pending;
    expect(result.isErr() && result.error.code).toBe("unknown_outcome");
    expect(result.isErr() && result.error.message).toContain("this orb");
    expect(result.isErr() && result.error.message).not.toContain("private-token");
  });

  it("requires an explicit self or full UUID target and normalizes UUID case", () => {
    expect(parse(["self"])._unsafeUnwrap()).toEqual({ self: true });
    expect(parse([orbId.toUpperCase()])._unsafeUnwrap()).toEqual({ orbId });
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
      expect(parse(args).isErr(), JSON.stringify(args)).toBe(true);
    }
  });
});
