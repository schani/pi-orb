import { calculateCost, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Result } from "neverthrow";
import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { assert, describe, expect, it, vi } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { durableError } from "./manager.ts";
import type { DurableModelsOptions, DurableModelToken } from "./models.ts";
import { createDurableModels } from "./models.ts";

describe("central broker native Models", () => {
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
    expect(runtime._unsafeUnwrapErr()).toEqual(
      durableError("owner model runtime initialization failed", true),
    );
  });

  it("rejects a late initialization grant after admission cancellation", async () => {
    const operation = new AbortController();
    const runtime = createDurableModels({
      signal: operation.signal,
      token: (signal) => {
        expect(signal).toBe(operation.signal);
        operation.abort();
        return okAsync({ accessToken: "late-bearer", expiresAt: Date.now() + 3600000 });
      },
    });
    expect((await runtime).isErr()).toBe(true);
  });

  it("resolves every request through the broker, without an OAuth store or ambient fallback", async () => {
    const before = process.env["PI_CODING_AGENT_DIR"];
    const token = vi.fn<DurableModelsOptions["token"]>(() =>
      okAsync({ accessToken: "owner-bearer", generation: 4, expiresAt: Date.now() + 3600000 }),
    );
    const runtime = (await createDurableModels({ token }))._unsafeUnwrap();
    expect(token).toHaveBeenCalledOnce();
    expect(runtime.getProviders().map(({ id }) => id)).toEqual(["openai-codex"]);
    expect(
      await runtime.getAuth("anthropic", { env: { ANTHROPIC_API_KEY: "ambient-canary" } }),
    ).toBeUndefined();
    expect(runtime.getProvider("openai-codex")?.auth.oauth).toBeUndefined();
    expect(runtime.getProvider("openai-codex")?.auth.apiKey?.resolve).toBeTypeOf("function");
    expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("owner-bearer");
    expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("owner-bearer");
    expect(token).toHaveBeenCalledTimes(3);
    token.mockImplementationOnce(() => errAsync(durableError("unavailable", true)));
    await expect(
      runtime.getAuth("openai-codex", {
        apiKey: "ambient-canary",
        env: { OPENAI_API_KEY: "secret" },
      }),
    ).rejects.toMatchObject({ code: "auth" });
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(before);
    expect(runtime.getModels("openai-codex")).toEqual(openaiCodexProvider().getModels());
  });

  it.each([
    {
      id: "gpt-6.2-astra",
      contextWindow: 272000,
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
    },
    {
      id: "gpt-6.2-sol",
      contextWindow: 500000,
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    },
  ])("registers $id with provider capabilities and list prices", async (expected) => {
    const runtime = (
      await createDurableModels({
        token: () => okAsync({ accessToken: "catalog-only", expiresAt: Date.now() + 3600000 }),
      })
    )._unsafeUnwrap();
    const model = runtime.getModel("openai-codex", expected.id);
    assert(model);
    expect(model).toMatchObject({
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: expected.contextWindow,
      maxTokens: 128000,
      cost: {
        input: expected.input,
        output: expected.output,
        cacheRead: expected.cacheRead,
        cacheWrite: expected.cacheWrite,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: expected.input * 2,
            output: expected.output * 1.5,
            cacheRead: expected.cacheRead * 2,
            cacheWrite: expected.cacheWrite * 2,
          },
        ],
      },
    });
    expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(runtime.getAllModels("openai-codex")).toContainEqual(model);
    for (const input of [271800, 271801]) {
      const cost = calculateCost(model, {
        input,
        output: 100,
        cacheRead: 100,
        cacheWrite: 100,
        reasoning: 0,
        totalTokens: input + 300,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      const long = input + 200 > 272000;
      expect(cost.input).toBeCloseTo((input * expected.input * (long ? 2 : 1)) / 1e6);
      expect(cost.output).toBeCloseTo((100 * expected.output * (long ? 1.5 : 1)) / 1e6);
      expect(cost.cacheRead).toBeCloseTo((100 * expected.cacheRead * (long ? 2 : 1)) / 1e6);
      expect(cost.cacheWrite).toBeCloseTo((100 * expected.cacheWrite * (long ? 2 : 1)) / 1e6);
    }
  });

  it("forwards request cancellation without cancelling another owner or publishing a late bearer", async () => {
    const controller = new AbortController();
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release = (_result: Result<DurableModelToken, RuntimeClientError>) => {};
    const held = new Promise<Result<DurableModelToken, RuntimeClientError>>((resolve) => {
      release = resolve;
    });
    let received: AbortSignal | undefined;
    const token = vi.fn<DurableModelsOptions["token"]>(() =>
      okAsync({ accessToken: "first-owner", expiresAt: Date.now() + 3600000 }),
    );
    const first = (await createDurableModels({ token }))._unsafeUnwrap();
    expect(first.getProvider("openai-codex")?.auth.apiKey?.resolve).toBeTypeOf("function");
    const otherToken = vi.fn(() =>
      okAsync({ accessToken: "other-owner", expiresAt: Date.now() + 3600000 }),
    );
    const other = (await createDurableModels({ token: otherToken }))._unsafeUnwrap();
    token.mockImplementationOnce((signal?: AbortSignal) => {
      received = signal;
      enter();
      return ResultAsync.fromSafePromise(held).andThen((result) => result);
    });
    const cancelled = first.getAuth("openai-codex", { signal: controller.signal });
    const rejected = expect(cancelled).rejects.toBeDefined();
    await entered;
    controller.abort();
    expect(received?.aborted).toBe(true);
    release(ok({ accessToken: "late-bearer", expiresAt: Date.now() + 3600000 }));
    await rejected;
    expect((await other.getAuth("openai-codex"))?.auth.apiKey).toBe("other-owner");
    expect((await first.getAuth("openai-codex"))?.auth.apiKey).toBe("first-owner");
    expect(token).toHaveBeenCalledTimes(3);
    expect(otherToken).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "applies broker auth and resolved endpoint on native inference (simple=%s)",
    async (simple) => {
      const runtime = (
        await createDurableModels({
          token: () =>
            okAsync({
              accessToken:
                "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoidGVzdCJ9fQ.signature",
              expiresAt: Date.now() + 3600000,
            }),
          inferenceBaseUrl: "https://broker-test.invalid/backend-api",
        })
      )._unsafeUnwrap();
      const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
      assert(model);
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }),
      );
      const complete = simple
        ? runtime.completeSimple.bind(runtime)
        : runtime.complete.bind(runtime);
      const result = await complete(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        { transport: "sse", maxRetries: 0, fetch },
      );
      expect(result.stopReason).toBe("error");
      expect(fetch).toHaveBeenCalledOnce();
      const request = fetch.mock.calls[0];
      assert(request);
      const [url, init] = request;
      expect(String(url)).toBe("https://broker-test.invalid/backend-api/codex/responses");
      expect(new Headers(init?.headers).get("authorization")).toContain("Bearer header.");
    },
  );
});
