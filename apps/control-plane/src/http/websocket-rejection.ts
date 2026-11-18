import type { FastifyInstance } from "fastify";

export function registerWebSocketRejectionCleanup(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    if (
      request.headers.upgrade !== undefined &&
      request.headers.connection
        ?.split(",")
        .some((token) => token.trim().toLowerCase() === "upgrade")
    ) {
      // Early auth hooks can reply before @fastify/websocket sets request.ws.
      // Its synthetic HTTP response has no Node HTTP socket cleanup handler.
      reply.raw.socket?.destroySoon?.();
    }
  });
}
