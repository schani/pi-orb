import { once } from "node:events";
import { get, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerResponseDrain } from "./response-drain.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("interrupts a backpressured response even after its source has closed", async () => {
  const app = Fastify({ logger: false });
  const stop = new AbortController();
  registerResponseDrain(app, stop.signal);
  const preClosed = gate();
  app.addHook("preClose", async () => preClosed.resolve());
  const bytes = 16 * 1024 * 1024;
  const source = Readable.from([Buffer.alloc(bytes)]);
  const sourceClosed = once(source, "close");
  let response: ServerResponse | undefined;
  app.get("/download", (_request, reply) => {
    response = reply.raw;
    return reply.send(source);
  });
  let client: IncomingMessage | undefined;
  let closing: Promise<void> | undefined;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    client = await new Promise<IncomingMessage>((resolve, reject) => {
      get(`${origin}/download`, (incoming) => {
        incoming.on("error", () => {});
        incoming.pause();
        resolve(incoming);
      }).on("error", reject);
    });
    await sourceClosed;
    expect(response?.writableFinished).toBe(false);
    stop.abort();
    closing = app.close();
    await preClosed.promise;
    expect(response?.destroyed).toBe(true);
    let received = 0;
    client.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    const disconnected = new Promise<void>((resolve) => client?.once("close", resolve));
    client.resume();
    await disconnected;
    await closing;
    expect(client.complete).toBe(false);
    expect(received).toBeLessThan(bytes);
  } finally {
    client?.destroy();
    response?.destroy();
    await (closing ?? app.close());
  }
});

it.each([false, true])(
  "finishes an admitted handler after shutdown (stream=%s)",
  async (stream) => {
    const app = Fastify({ logger: false });
    const stop = new AbortController();
    registerResponseDrain(app, stop.signal);
    const entered = gate();
    const release = gate();
    const preClosed = gate();
    app.addHook("preClose", async () => preClosed.resolve());
    app.get("/admitted", async (_request, reply) => {
      entered.resolve();
      await release.promise;
      return reply.send(stream ? Readable.from(["download"]) : { committed: true });
    });
    let closing: Promise<void> | undefined;
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const result = new Promise<unknown>((resolve) => {
        get(`${origin}/admitted`, (incoming) => {
          let body = "";
          incoming.on("data", (chunk) => {
            body += chunk.toString();
          });
          incoming.on("end", () => resolve({ status: incoming.statusCode, body }));
        }).on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code }));
      });
      await entered.promise;
      stop.abort();
      closing = app.close();
      await preClosed.promise;
      release.resolve();
      expect(await result).toEqual(
        stream ? { error: "ECONNRESET" } : { status: 200, body: '{"committed":true}' },
      );
      await closing;
    } finally {
      release.resolve();
      await (closing ?? app.close());
    }
  },
);
