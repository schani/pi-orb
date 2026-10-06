import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { holdModelStream, isModelCompletion } from "./held-model-stream.ts";

it.each([false, true])(
  "forwards model deltas while completion remains held: compressed=%s",
  async (compressed) => {
    const delta =
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"visible"}\n\n';
    const completed = 'data: {"response":{"id":"reply"},"type":"response.completed"}\r\n\r\n';
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(delta + completed);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream address");
    const relay = await holdModelStream(`http://127.0.0.1:${address.port}`, "HOLD");
    try {
      expect((await fetch(relay.baseUrl)).status).toBe(426);
      const response = await fetch(relay.baseUrl, {
        method: "POST",
        body: compressed
          ? zstdCompressSync(
              Buffer.from(
                JSON.stringify({
                  input: [{ text: "HOLD" }],
                  tools: Array.from({ length: 10 }, (_, index) => ({
                    name: `read${index}`,
                    description: "Read file contents and return text with limits and paths.",
                  })),
                }),
              ),
            )
          : "HOLD",
        headers: compressed ? { "content-encoding": "zstd" } : {},
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(delta);
      expect(relay.held()).toBe(true);
      expect(relay.observations[0]).toMatchObject({
        targeted: true,
        reasoningDeltaForwarded: true,
        completionHeld: true,
      });
      const unrelated = await fetch(relay.baseUrl, { method: "POST", body: "SUMMARY_OTHER_TURN" });
      expect(await unrelated.text()).toBe(delta + completed);
      expect(relay.observations[1]).toMatchObject({
        targeted: false,
        completionHeld: false,
      });
      relay.release();
      let remaining = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        remaining += new TextDecoder().decode(next.value);
      }
      expect(remaining).toBe(completed);
    } finally {
      await relay.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

it("holds model completion, not text deltas or unrelated data", () => {
  expect(
    isModelCompletion('event: response.completed\ndata: {"type":"response.completed"}\n\n'),
  ).toBe(true);
  expect(
    isModelCompletion('data: {"response":{"id":"reply"},"type":"response.completed"}\n\n'),
  ).toBe(true);
  expect(
    isModelCompletion(
      'data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n',
    ),
  ).toBe(false);
  expect(
    isModelCompletion('data: {"type":"response.output_text.delta","delta":"streamed"}\n\n'),
  ).toBe(false);
});
