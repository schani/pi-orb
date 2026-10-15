import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  supportedModels: vi.fn(),
  close: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

import { checkClaudeSpawnModel } from "./claude-model-catalog.ts";

describe("ephemeral Claude catalog", () => {
  it("checks exact SDK model IDs without sending input or retaining a session", async () => {
    sdk.query.mockReturnValue(sdk);
    sdk.supportedModels.mockResolvedValue([
      { value: "opus", displayName: "Opus", description: "" },
    ]);
    const result = await checkClaudeSpawnModel("owner-token", "opus");
    expect(result.isOk()).toBe(true);
    const call = sdk.query.mock.calls.at(-1)?.[0];
    expect(call.options.persistSession).toBe(false);
    expect(call.options.settingSources).toEqual([]);
    expect(call.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("owner-token");
    expect(typeof call.prompt).not.toBe("string");
    expect(await call.prompt.next()).toMatchObject({ done: true });
    expect(sdk.close).toHaveBeenCalled();
  });
  it("rejects an exact ID absent from SDK advertisement", async () => {
    sdk.query.mockReturnValue(sdk);
    sdk.supportedModels.mockResolvedValue([
      { value: "opus", displayName: "Opus", description: "" },
    ]);
    expect((await checkClaudeSpawnModel("owner-token", "sonnet"))._unsafeUnwrapErr().reason).toBe(
      "invalid",
    );
  });
  it("closes discovery and returns a typed sanitized failure", async () => {
    sdk.close.mockClear();
    sdk.query.mockReturnValue(sdk);
    sdk.supportedModels.mockRejectedValue(new Error("private"));
    const result = await checkClaudeSpawnModel("owner-token", "opus");
    expect(result.isErr() && result.error).toEqual({
      type: "spawn_model_error",
      reason: "unavailable",
      message: "Claude model lookup unavailable.",
    });
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
});

it.each(["query", "close"] as const)(
  "maps synchronous SDK %s exceptions to typed failures",
  async (stage) => {
    sdk.query.mockImplementation(() => {
      if (stage === "query") throw new Error("private-token");
      return sdk;
    });
    sdk.supportedModels.mockResolvedValue([]);
    sdk.close.mockImplementation(() => {
      if (stage === "close") throw new Error("private-token");
    });
    const result = await checkClaudeSpawnModel("owner-token", "opus");
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "spawn_model_error",
      reason: "unavailable",
      message: "Claude model lookup unavailable.",
    });
  },
);
