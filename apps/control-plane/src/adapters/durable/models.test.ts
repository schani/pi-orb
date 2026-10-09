import type { Result } from "neverthrow";
import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { durableError } from "./manager.ts";
import type { DurableModelToken } from "./models.ts";
import { createDurableModels } from "./models.ts";

describe("central broker ModelRuntime", () => {
  it("forwards initialization admission cancellation before seeding credentials", async () => {
    const operation = new AbortController();
    operation.abort();
    const runtime = await createDurableModels({
      signal: operation.signal,
      token: (signal) => {
        expect(signal).toBe(operation.signal);
        return errAsync(durableError("cancelled", true));
      },
    });
    expect(runtime.isErr()).toBe(true);
  });
  it("forwards pinned SDK refresh cancellation without cancelling another runtime", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000000);
    const controllers = [new AbortController(), new AbortController()];
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release = (_result: Result<DurableModelToken, RuntimeClientError>) => {};
    const held = new Promise<Result<DurableModelToken, RuntimeClientError>>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let received: AbortSignal | undefined;
    const token = (signal?: AbortSignal) => {
      calls++;
      if (calls !== 3)
        return okAsync({ accessToken: `owner-bearer-${calls}`, expiresAt: Date.now() + 3600000 });
      received = signal;
      enter();
      return ResultAsync.fromSafePromise(held).andThen((result) => result);
    };
    try {
      const first = (await createDurableModels({ token }))._unsafeUnwrap();
      const other = (await createDurableModels({ token }))._unsafeUnwrap();
      now.mockReturnValue(1000000 + 56 * 60000);
      const cancelled = first
        .getAuth("openai-codex", { signal: controllers[0]!.signal })
        .catch(() => undefined);
      await entered;
      try {
        expect(received).toBeDefined();
        controllers[0]!.abort();
        expect(received?.aborted).toBe(true);
        expect(controllers[1]!.signal.aborted).toBe(false);
      } finally {
        release(ok({ accessToken: "late-bearer", expiresAt: Date.now() + 3600000 }));
        await cancelled;
      }
      expect(await cancelled).toBeUndefined();
      expect(
        (await other.getAuth("openai-codex", { signal: controllers[1]!.signal }))?.auth.apiKey,
      ).toBe("owner-bearer-4");
      expect((await first.getAuth("openai-codex"))?.auth.apiKey).toBe("owner-bearer-5");
      expect(calls).toBe(5);
    } finally {
      now.mockRestore();
    }
  });
  it("resolves owner credentials without changing process agent directory", async () => {
    const before = process.env["PI_CODING_AGENT_DIR"];
    const runtime = await createDurableModels({
      token: () =>
        okAsync({ accessToken: "owner-bearer", generation: 4, expiresAt: Date.now() + 3600000 }),
    });
    expect(runtime.isOk()).toBe(true);
    const auth = await runtime._unsafeUnwrap().getAuth("openai-codex");
    expect(auth?.auth.apiKey).toBe("owner-bearer");
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(before);
  });
});
