import type { AssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import * as durableModels from "./adapters/durable/models.ts";
import type { ModelCall } from "./domain/model-usage.ts";
import { createProcessAgentContext } from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "./testkit/fixtures.ts";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@pi-orb/luna", () => ({ completeLuna: mocks.complete }));

const response: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "gpt-6-luna",
  usage: {
    input: 70,
    output: 9,
    cacheRead: 64,
    cacheWrite: 0,
    totalTokens: 143,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0021 },
  },
  stopReason: "stop",
  responseId: "resp_luna",
  durationMs: 512,
  timestamp: 0,
};
const call = {
  provider: "openai-codex",
  model: "gpt-6-luna",
  outcome: "stop",
  input: 70,
  output: 9,
  cacheRead: 64,
  cacheWrite: 0,
  costUsd: 0.0021,
  durationMs: 512,
  responseId: "resp_luna",
};

it("attributes durable and turn-summary calls to the orb and its owner", async () => {
  const harness = makeHarness();
  const orb = makeOrbRow("central", "project", "stopped");
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(orb);
  const task = new NoSimulationTask("model usage composition", false);
  const recorded: ModelCall[] = [];
  const models = vi.spyOn(durableModels, "createDurableModels").mockReturnValue(
    okAsync({
      getModel: () => ({ id: "gpt-6-luna" }),
      getAuth: () => Promise.resolve({ auth: { apiKey: "token" } }),
    } as never),
  );
  mocks.complete.mockImplementation((request: { onResponse?: (value: unknown) => void }) => {
    request.onResponse?.(response);
    return okAsync("Fixed the parser.");
  });
  try {
    const open = createProcessAgentContext(harness.deps, {
      mcp: { read: () => okAsync({ servers: [] }) },
      resources: {
        acquire: () =>
          okAsync({
            orbId: orb.id,
            commitSha: "a".repeat(40),
            instructionPath: null,
            skillRoot: null,
            files: [],
          }),
      },
      modelUsage: { record: (_task: unknown, call: ModelCall) => void recorded.push(call) },
    } as never);
    const opened = await open(task, orb, { signal: new AbortController().signal }, true, {
      storage: new MemoryStorage(),
      signal: new AbortController().signal,
      check: () => okAsync(undefined),
      checkInputAdmission: () => okAsync(undefined),
      beginDrain: () => okAsync(undefined),
      release: () => okAsync(undefined),
      artifacts: { read: () => okAsync(null), write: () => okAsync("/orb-artifacts/fixture") },
    });
    expect(opened.isOk(), opened.isErr() ? opened.error.message : "").toBe(true);
    const options = opened._unsafeUnwrap();
    options.recordModelCall?.(
      "subagent",
      { ...response, model: "gpt-6-astra" },
      { ttftMs: 40, thinkingMs: 300 },
    );
    const summary = await options.turnSummary?.summarizer.summarize(
      { transcript: "turn" },
      { signal: new AbortController().signal },
    );
    expect(summary?._unsafeUnwrap()).toBe("Fixed the parser.");
    const scope = { ownerUserId: TEST_USER_ID, orbId: orb.id };
    expect(recorded).toEqual([
      { ...call, model: "gpt-6-astra", ...scope, use: "subagent", ttftMs: 40, thinkingMs: 300 },
      { ...call, ...scope, use: "turn_summary" },
    ]);
    await options.closeResources?.();
  } finally {
    models.mockRestore();
  }
});
