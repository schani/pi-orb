import { afterEach, expect, it, vi } from "vitest";
import { requestSelfArchive } from "./command.ts";

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
  const pending = requestSelfArchive({
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
