import { complete } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { lunaRequestOptions, resolveLunaModel } from "./index.ts";

describe("pinned Luna SDK transport", () => {
  it("issues exactly one SSE request per call on provider HTTP 503", async () => {
    const options = lunaRequestOptions({
      maxTokens: 96,
      sessionPrefix: "transport-contract",
      signal: new AbortController().signal,
    });
    // Fail before any transport is admitted if the policy would select WebSocket.
    expect(options.transport).toBe("sse");
    expect(options.maxRetries).toBe(0);
    const model = resolveLunaModel();
    expect(model).toBeDefined();
    if (model === undefined) return;
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "synthetic unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await complete(
      { ...model, baseUrl: "https://inference.invalid" },
      { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] },
      { ...options, apiKey: `header.${payload}.signature`, fetch },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.diagnostics).toMatchObject([
      {
        type: "codex_failure",
        status: 503,
        transport: "sse",
        phase: "before_message_stream_start",
        attempt: 1,
      },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("websocket");
  });
});
