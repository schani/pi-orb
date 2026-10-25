import type { Models } from "@earendil-works/pi-ai";
import { okAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import { createDurableModels } from "./durable/models.ts";
import { LunaTurnSummarizer } from "./luna-summarizer.ts";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@pi-orb/luna", () => ({ completeLuna: mocks.complete }));

it("hands Luna responses to the usage recorder when one is given", async () => {
  const runtime = {
    getAuth: () => Promise.resolve({ auth: { apiKey: "token" } }),
  } as unknown as Models;
  const template = {} as Parameters<Models["completeSimple"]>[0];
  const context = { signal: new AbortController().signal };
  const onResponse = vi.fn();
  mocks.complete.mockReturnValue(okAsync("Fixed the parser."));
  await new LunaTurnSummarizer(runtime, template, onResponse).summarize(
    { transcript: "t" },
    context,
  );
  await new LunaTurnSummarizer(runtime, template).summarize({ transcript: "t" }, context);
  expect(mocks.complete.mock.calls[0]?.[0].onResponse).toBe(onResponse);
  expect(mocks.complete.mock.calls[1]?.[0]).not.toHaveProperty("onResponse");
});

it("forwards native broker auth, endpoint and cancellation to auxiliary Luna", async () => {
  const token = vi.fn(() =>
    okAsync({ accessToken: "owner-token", expiresAt: Date.now() + 3600000 }),
  );
  const runtime = (
    await createDurableModels({ token, inferenceBaseUrl: "https://luna-test.invalid" })
  )._unsafeUnwrap();
  const auth = vi.spyOn(runtime, "getAuth");
  const template = runtime.getModel("openai-codex", "gpt-6-luna");
  assert(template);
  const context = { signal: new AbortController().signal };
  mocks.complete.mockReturnValue(okAsync("Fixed the parser."));
  const result = await new LunaTurnSummarizer(runtime, template).summarize(
    { transcript: "t" },
    context,
  );
  expect(result._unsafeUnwrap()).toBe("Fixed the parser.");
  expect(auth).toHaveBeenCalledWith(template, { signal: context.signal });
  expect(mocks.complete).toHaveBeenLastCalledWith(
    expect.objectContaining({
      auth: { apiKey: "owner-token", baseUrl: "https://luna-test.invalid" },
      signal: context.signal,
    }),
  );
  expect(token).toHaveBeenCalledTimes(2);
});
