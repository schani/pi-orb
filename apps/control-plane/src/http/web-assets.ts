import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

const PAGE_NOT_FOUND =
  '<!doctype html><title>Page doesn’t exist</title><p>Page doesn’t exist.</p><a href="/">Dashboard</a>';

export async function registerWebAssets(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path === "/api" || path.startsWith("/api/")) {
      return reply.status(404).send({ error: { code: "not_found" } });
    }
    if (request.method === "HEAD") {
      return reply.status(404).type("text/html; charset=utf-8").send();
    }
    if (request.method === "GET") {
      return reply.status(404).type("text/html; charset=utf-8").send(PAGE_NOT_FOUND);
    }
    return reply.status(404).send({ error: { code: "not_found" } });
  });
}
