import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { matcherRequest, requestedToolEvents } from "./durable-model-fixture.ts";

/** Adapt the legacy hosted fake, not the real provider or application protocol. */
export async function durableFakeRelay(upstreamBase: string) {
  const upstream = new URL(upstreamBase);
  const requests: Record<string, unknown>[] = [];
  let failure: unknown;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(426).end();
      return;
    }
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const compressed = Buffer.concat(chunks);
      const decoded =
        request.headers["content-encoding"] === "zstd"
          ? zstdDecompressSync(compressed)
          : compressed;
      const body = JSON.parse(decoded.toString()) as Record<string, unknown>;
      requests.push(body);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (
          ["host", "connection", "content-length", "content-encoding"].includes(key) ||
          value === undefined
        )
          continue;
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const result = await fetch(new URL(request.url ?? "/", upstream.origin), {
        method: "POST",
        headers,
        body: JSON.stringify(matcherRequest(body)),
        signal: abort.signal,
      });
      response.writeHead(result.status, {
        "content-type": result.headers.get("content-type") ?? "text/event-stream",
      });
      if (!result.body) {
        response.end();
        return;
      }
      if (!result.headers.get("content-type")?.includes("text/event-stream")) {
        for await (const chunk of result.body) response.write(chunk);
        response.end();
        return;
      }
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of result.body) {
        buffered += decoder.decode(chunk, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(buffered);
        while (boundary) {
          const end = boundary.index + boundary[0].length;
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") {
            const event = JSON.parse(data) as Record<string, unknown>;
            for (const translated of requestedToolEvents(body, event)) {
              response.write(
                `event: ${translated["type"]}\ndata: ${JSON.stringify(translated)}\n\n`,
              );
            }
          } else response.write(frame);
          boundary = /\r?\n\r?\n/.exec(buffered);
        }
      }
      response.end(buffered + decoder.decode());
    } catch (cause) {
      if (!abort.signal.aborted) failure = cause;
      response.destroy();
    }
  });
  server.on("upgrade", (_request, socket) =>
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fake relay listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}${upstream.pathname}`,
    requests,
    check: () => {
      if (failure) throw failure;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (failure) throw failure;
    },
  };
}
