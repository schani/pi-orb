import { Writable } from "node:stream";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createHistoryStream, sendHistoryStream } from "./history-stream.ts";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it("sends the exact JSON object via HTTP/1.1 chunks without Content-Length, even over 32 MiB", async () => {
  const task = new NoSimulationTask("history stream", false);
  const log = vi.spyOn(task, "log");
  const app = Fastify({ logger: false });
  apps.push(app);
  const record = { id: "one", content: [{ type: "text", text: "x".repeat(33 * 1024 * 1024) }] };
  const head = {
    v: 1,
    orb: { id: "orb" },
    session: { id: "session" },
    cursor: "one",
    headId: "one",
  };
  app.get("/", (_, reply) => sendHistoryStream(reply, task, "orb", head, [record]));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("unexpected test listener");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("transfer-encoding")).toBe("chunked");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.text()).toBe(JSON.stringify({ ...head, records: [record] }));
  expect(log).toHaveBeenCalledWith(
    `lifecycle: orb=orb history-streamed producedBytes=${Buffer.byteLength(JSON.stringify({ ...head, records: [record] }))} totalRecords=1`,
  );
});

it("honors explicit writable demand and stops serializing on cancellation", async () => {
  const visited: number[] = [];
  const records = Array.from({ length: 100 }, (_, i) => ({
    toJSON() {
      visited.push(i);
      return { id: i };
    },
  }));
  const stream = createHistoryStream({ cursor: null }, records);
  let entered!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  let writes = 0;
  const gate = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writes++;
      entered();
      release = callback;
    },
  });
  stream.pipe(gate);
  await firstWrite;
  expect(visited.length).toBeLessThan(3);
  expect(writes).toBe(1);
  // Register demand before releasing the first write.
  const secondWrite = new Promise<void>((resolve) => {
    entered = resolve;
  });
  release();
  await secondWrite;
  const count = visited.length;
  expect(writes).toBe(2);
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.destroy();
  await closed;
  expect(visited.length).toBe(count);
  expect(count).toBeLessThan(records.length);
  gate.destroy();
});

it("serializes an empty metadata object as valid JSON", async () => {
  const app = Fastify();
  apps.push(app);
  app.get("/", (_request, reply) =>
    sendHistoryStream(reply, new NoSimulationTask("empty", false), "orb", {}, []),
  );
  const response = await app.inject("/");
  expect(response.body).toBe('{"records":[]}');
});

it("counts emitted UTF-8 bytes without retaining record content", async () => {
  const stats = { producedBytes: 0, failed: false };
  let body = "";
  for await (const chunk of createHistoryStream({ cursor: "é" }, [{ id: "☃" }], stats)) {
    body += chunk;
  }
  expect(stats).toEqual({ producedBytes: Buffer.byteLength(body), failed: false });
  expect(JSON.parse(body)).toEqual({ cursor: "é", records: [{ id: "☃" }] });
});

it("destroys a failed stream rather than completing a valid partial JSON document", async () => {
  const task = new NoSimulationTask("history failure", false);
  const log = vi.spyOn(task, "log");
  const app = Fastify({ logger: false });
  apps.push(app);
  app.get("/", (_, reply) =>
    sendHistoryStream(reply, task, "orb", { cursor: null }, [
      { id: "ok" },
      {
        toJSON() {
          throw new Error("secret content");
        },
      },
    ]),
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("unexpected test listener");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow();
  expect(log).toHaveBeenCalledWith(
    expect.stringMatching(
      /^lifecycle: orb=orb history-stream-incomplete producedBytes=\d+ totalRecords=2 reason=serialization$/,
    ),
  );
  expect(log.mock.calls.flat().join("")).not.toContain("secret content");
});
