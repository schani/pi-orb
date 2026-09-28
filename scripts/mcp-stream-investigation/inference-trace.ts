import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";

interface TraceRecord {
  route: "responses" | "other";
  method: string;
  upstreamStatus?: number;
  eventTypes: string[];
  outcome?:
    | "upstream_eof"
    | "upstream_error"
    | "client_close"
    | "client_close_after_terminal"
    | "injected_cutoff";
  errorName?: string;
}

/** Diagnostic-only forwarding boundary. Never persists model payloads or credentials. */
export async function startInferenceTrace(
  upstreamBaseUrl: string,
  options: { cutIsolationOnce?: boolean } = {},
) {
  const upstream = new URL(upstreamBaseUrl);
  const records: TraceRecord[] = [];
  let cutAvailable = options.cutIsolationOnce === true;
  const server = createServer(async (req, res) => {
    const record: TraceRecord = {
      route: req.url?.endsWith("/responses") ? "responses" : "other",
      method: req.method ?? "unknown",
      eventTypes: [],
    };
    records.push(record);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded && record.outcome === undefined) {
        record.outcome = record.eventTypes.includes("response.completed")
          ? "client_close_after_terminal"
          : "client_close";
        controller.abort();
      }
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const readableBody =
        req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(body) : body;
      const cutThisStream = cutAvailable && readableBody.includes("MCP isolation");
      if (cutThisStream) cutAvailable = false;
      const url = new URL(req.url ?? "", upstream);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (key !== "host" && key !== "content-length" && value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const response = await fetch(url, {
        method: req.method ?? "POST",
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
        signal: controller.signal,
      });
      record.upstreamStatus = response.status;
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "text/event-stream",
      });
      const reader = response.body?.getReader();
      if (!reader) {
        record.outcome = "upstream_error";
        record.errorName = "missing_response_body";
        res.destroy();
        return;
      }
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          if (record.outcome === undefined) record.outcome = "upstream_eof";
          res.end();
          break;
        }
        pending += decoder.decode(next.value, { stream: true });
        let boundary = pending.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as { type?: unknown };
              if (typeof event.type === "string") record.eventTypes.push(event.type);
            } catch {
              /* diagnostic parser only */
            }
          }
          if (cutThisStream && record.eventTypes.includes("response.created")) {
            record.outcome = "injected_cutoff";
            res.end(`${frame}\n\n`);
            controller.abort();
            return;
          }
          boundary = pending.indexOf("\n\n");
        }
        res.write(next.value);
      }
    } catch (cause) {
      if (record.outcome === undefined) record.outcome = "upstream_error";
      record.errorName = cause instanceof Error ? cause.name : "unknown";
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    return Promise.reject(new Error("inference trace server did not listen"));
  return {
    baseUrl: `http://127.0.0.1:${address.port}${upstream.pathname}`,
    records,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
