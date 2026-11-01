import { zstdDecompressSync } from "node:zlib";
import { type Context, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { assert, expect, it, vi } from "vitest";

it.each([false, true])(
  "serializes Codex tool content, not private native details (explicit output: %s)",
  async (printed) => {
    const secret = "PRIVATE_PREVIEW_WIRE_CANARY";
    const publicText = "PUBLIC_TOOL_CONTENT_CONTROL";
    const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
    const context: Context = {
      messages: [
        { role: "user", content: "run", timestamp: 0 },
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [
            {
              type: "toolCall",
              id: "call_content",
              name: "codemode",
              arguments: { code: 'text("safe")' },
            },
          ],
          stopReason: "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_content",
          toolName: "codemode",
          content: [{ type: "text", text: printed ? publicText + secret : publicText }],
          details: {
            calls: [{ name: "unlaunched", args: JSON.stringify({ secret }), status: "cancelled" }],
          },
          isError: false,
          timestamp: 0,
        },
      ],
    };
    const bodies: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      const encoding = new Headers(init?.headers).get("content-encoding");
      bodies.push(
        encoding === "zstd"
          ? zstdDecompressSync(init?.body as Uint8Array).toString("utf8")
          : String(init?.body),
      );
      return new Response(JSON.stringify({ error: { message: "capture only" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
    ).toString("base64url");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: `header.${claims}.signature`,
      refresh: "unused",
      expires: Date.now() + 3600000,
    }));
    const result = await builtinModels({ credentials }).completeSimple(model, context, {
      transport: "sse",
      maxRetries: 0,
      fetch,
      env: {},
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("capture only");
    expect(fetch).toHaveBeenCalledOnce();
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(context.messages.at(-1))).toContain(secret);
    const body = bodies[0];
    assert(body !== undefined);
    expect(body).toContain(publicText);
    expect(body.includes(secret)).toBe(printed);
    expect(body).not.toContain('"details"');
    const resultMessage = context.messages.at(-1);
    assert(resultMessage !== undefined);
    expect(resultMessage.role).toBe("toolResult");
    if (resultMessage.role === "toolResult") delete resultMessage.details;
    await builtinModels({ credentials }).completeSimple(model, context, {
      transport: "sse",
      maxRetries: 0,
      fetch,
      env: {},
    });
    expect(JSON.parse(bodies[1] ?? "").input).toEqual(JSON.parse(body).input);
    expect(JSON.parse(body).input).toContainEqual({
      type: "function_call_output",
      call_id: "call_content",
      output: printed ? publicText + secret : publicText,
    });
  },
);
