import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { LunaTurnSummarizer } from "./luna-summarizer.ts";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@pi-orb/luna", () => ({ completeLuna: mocks.complete }));

it("hands Luna responses to the usage recorder when one is given", async () => {
  const runtime = {
    getAuth: () => Promise.resolve({ auth: { apiKey: "token" } }),
  } as unknown as ModelRuntime;
  const template = {} as Parameters<ModelRuntime["completeSimple"]>[0];
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
