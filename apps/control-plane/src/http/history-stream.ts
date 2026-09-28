import { Readable } from "node:stream";
import type { SimulationTask } from "determined";
import type { FastifyReply } from "fastify";
import { Result } from "neverthrow";
import { logOrbEvent } from "../domain/log.ts";

/** The producer is shared by HTTP and gated-writable scheduling tests. */
export function createHistoryStream(
  metadata: Record<string, unknown>,
  records: readonly unknown[],
  stats: { producedBytes: number; failed: boolean } = { producedBytes: 0, failed: false },
): Readable {
  const encode = (value: unknown): string => {
    const encoded = Result.fromThrowable(JSON.stringify, () => ({
      type: "serialization_failed" as const,
    }))(value);
    if (encoded.isErr() || typeof encoded.value !== "string") {
      stats.failed = true;
      // Node's Readable error contract requires an Error; never expose the original exception.
      // biome-ignore lint/plugin/no-throw: Node stream generators signal failure by throwing.
      throw new Error("history serialization failed");
    }
    return encoded.value;
  };
  const chunk = (text: string): string => {
    stats.producedBytes += Buffer.byteLength(text);
    return text;
  };
  const chunks = function* () {
    const prefix = encode(metadata).slice(0, -1);
    yield chunk(`${prefix}${prefix === "{" ? "" : ","}"records":[`);
    for (let index = 0; index < records.length; index++) {
      if (index > 0) yield chunk(",");
      yield chunk(encode(records[index]));
    }
    yield chunk("]}");
  };
  return Readable.from(chunks(), { highWaterMark: 1 });
}

/** Keep the existing JSON shape while letting Node pipe enforce backpressure and cancellation. */
export function sendHistoryStream(
  reply: FastifyReply,
  task: SimulationTask,
  orbId: string,
  metadata: Record<string, unknown>,
  records: readonly unknown[],
): FastifyReply {
  const stats = { producedBytes: 0, failed: false };
  const stream = createHistoryStream(metadata, records, stats);
  let finished = false;
  reply.raw.once("finish", () => {
    finished = true;
    if (stats.producedBytes > 32 * 1024 * 1024)
      logOrbEvent(task, orbId, "history-streamed", {
        producedBytes: stats.producedBytes,
        totalRecords: records.length,
      });
  });
  reply.raw.once("close", () => {
    if (!finished)
      logOrbEvent(task, orbId, "history-stream-incomplete", {
        producedBytes: stats.producedBytes,
        totalRecords: records.length,
        reason: stats.failed ? "serialization" : "disconnect",
      });
  });
  reply.header("content-type", "application/json; charset=utf-8");
  return reply.send(stream);
}
