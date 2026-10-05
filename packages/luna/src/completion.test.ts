import { describe, expect, it, vi } from "vitest";
import { completeLuna } from "./index.ts";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: mocks.complete }));
const request = {
  systemPrompt: "SECRET_PROMPT",
  prompt: "SECRET_SOURCE",
  timestamp: 1,
  maxTokens: 96,
  sessionPrefix: "test",
  signal: new AbortController().signal,
  auth: { apiKey: "SECRET_TOKEN" },
};
describe("Luna terminal failure diagnostics", () => {
  it("retains only validated terminal provider facts", async () => {
    mocks.complete.mockResolvedValue({
      stopReason: "error",
      errorMessage: "SECRET_ERROR",
      content: [],
      diagnostics: [
        {
          type: "codex_failure",
          status: 503,
          transport: "sse",
          phase: "before_message_stream_start",
          code: "SECRET_CODE",
        },
      ],
      usage: { input: 1, output: 2, totalTokens: 3, reasoning: "SECRET_USAGE" },
    });
    const failure = (await completeLuna(request))._unsafeUnwrapErr();
    expect(failure).toMatchObject({
      reason: "provider_error",
      providerStatus: 503,
      transport: "sse",
      phase: "before_message_stream_start",
      stopReason: "error",
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(failure.errorCode).toBeUndefined();
    expect(JSON.stringify(failure)).not.toMatch(
      /SECRET_CODE|SECRET_USAGE|SECRET_TOKEN|SECRET_SOURCE/,
    );
    expect(mocks.complete.mock.calls.at(-1)?.[2]).toMatchObject({ maxRetries: 0 });
  });
  it.each([
    { diagnostics: undefined, errorMessage: "HTTP 503" },
    { diagnostics: [{ type: "other", status: 503 }] },
    { diagnostics: [{ type: "codex_failure", status: "503" }] },
    {
      diagnostics: [
        { type: "codex_failure", status: 503 },
        { type: "codex_failure", status: 429 },
      ],
    },
    { diagnostics: [{ type: "codex_failure", status: 503 }, { type: "codex_failure" }] },
  ])("does not infer 503 from messages or earlier failures: %j", async (extra) => {
    mocks.complete.mockResolvedValue({ stopReason: "error", content: [], ...extra });
    expect((await completeLuna(request))._unsafeUnwrapErr().providerStatus).not.toBe(503);
  });
  it("maps rejection and empty completion without retry facts", async () => {
    mocks.complete.mockRejectedValue(new Error("SECRET_503"));
    expect((await completeLuna(request))._unsafeUnwrapErr()).toMatchObject({
      reason: "completion_rejected",
    });
    mocks.complete.mockResolvedValue({
      stopReason: "stop",
      content: [],
      diagnostics: [{ type: "codex_failure", status: 503 }],
    });
    expect((await completeLuna(request))._unsafeUnwrapErr()).toMatchObject({
      reason: "empty_text",
    });
    expect((await completeLuna(request))._unsafeUnwrapErr().providerStatus).toBeUndefined();
  });
});
