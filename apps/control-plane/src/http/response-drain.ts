import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";

export function registerResponseDrain(app: FastifyInstance, stop: AbortSignal): void {
  const responses = new Set<ServerResponse>();
  app.addHook("onSend", async (_request, reply, payload) => {
    if (payload instanceof Readable) {
      if (stop.aborted) reply.raw.destroy();
      else {
        responses.add(reply.raw);
        reply.raw.once("close", () => responses.delete(reply.raw));
      }
    }
    return payload;
  });
  app.addHook("preClose", async () => {
    for (const response of responses) response.destroy();
  });
}
