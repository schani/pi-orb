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

  it.each(["throw", "reject"])(
    "maps a fetch %s to a typed visible prerequisite failure",
    async (mode) => {
      vi.stubGlobal("fetch", () => {
        if (mode === "throw") throw new Error("network down");
        return Promise.reject(new Error("network down"));
      });
      const result = await fetchBootContext(broker);
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: "boot_context_error",
        retryable: true,
      });
      expect(result._unsafeUnwrapErr().message).toContain("boot context");
    },
  );

  it("fails closed on a malformed successful response", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ v: 1 }), { status: 200 }));
    const result = await fetchBootContext(broker);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "boot_context_error",
      retryable: true,
    });
  });
});
