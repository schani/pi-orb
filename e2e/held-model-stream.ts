import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { Result } from "neverthrow";

/** SSE completion fence; deltas reach the real browser before model completion. */
export function isModelCompletion(event: string): boolean {
  return event.split(/\r?\n/).some((line) => {
    if (line.startsWith("event:")) return line.slice(6).trim() === "response.completed";
    if (!line.startsWith("data:")) return false;
    const parsed = Result.fromThrowable(
      () => JSON.parse(line.slice(5)) as unknown,
      () => null,
    )();
    return (
      parsed.isOk() &&
      typeof parsed.value === "object" &&
      parsed.value !== null &&
      "type" in parsed.value &&
      parsed.value.type === "response.completed"
    );
  });
}

export async function holdModelStream(
  upstreamBase: string,
  marker: string,
  listener: { host: string; advertisedHost: string } = {
    host: "127.0.0.1",
    advertisedHost: "127.0.0.1",
  },
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  let failure: unknown;
  const observations: {
    targeted: boolean;
    encoding: string;
    reasoningDeltaForwarded: boolean;
    completionHeld: boolean;
  }[] = [];
  const upstream = new URL(upstreamBase);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(426).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const decodedBody =
        request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(body) : body;
      const targeted = decodedBody.toString().includes(marker);
      const observation = {
        targeted,
        encoding: String(request.headers["content-encoding"] ?? "identity"),
        reasoningDeltaForwarded: false,
        completionHeld: false,
      };
      observations.push(observation);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (
          key === "host" ||
          key === "connection" ||
          key === "content-length" ||
          value === undefined
        )
          continue;
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const result = await fetch(new URL(request.url ?? "/", upstream.origin), {
        method: request.method ?? "POST",
        headers,
        body,
      });
      response.writeHead(result.status, {
        "content-type": result.headers.get("content-type") ?? "text/event-stream",
      });
      if (!result.body) {
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
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end);
          if (targeted && isModelCompletion(event)) {
            held = true;
            observation.completionHeld = true;
            await gate;
          }
          response.write(event);
          if (
            targeted &&
            /"type"\s*:\s*"response\.reasoning(?:_summary)?_text\.delta"/.test(event)
          ) {
            observation.reasoningDeltaForwarded = true;
          }
          boundary = /\r?\n\r?\n/.exec(buffered);
        }
      }
      response.end(buffered + decoder.decode());
    } catch (error) {
      failure = error;
      response.destroy();
    }
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, listener.host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing model stream listener");
  return {
    baseUrl: `http://${listener.advertisedHost}:${address.port}${upstream.pathname}`,
    observations,
    held: () => {
      if (failure) throw failure;
      return held;
    },
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
