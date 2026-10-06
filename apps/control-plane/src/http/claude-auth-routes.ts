import { CLAUDE_AUTH_PATH } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance } from "fastify";
import type { ClaudeSubscriptionAuth } from "../domain/claude-auth.ts";

export function registerClaudeAuthRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  auth: ClaudeSubscriptionAuth,
  appOrigin: string,
): void {
  app.get(CLAUDE_AUTH_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = request.principal;
    if (principal?.kind !== "user") return reply.code(403).send({ error: "owner_required" });
    const result = await auth.status(task, principal.user.id);
    return result.isOk()
      ? reply.send(result.value)
      : reply.code(503).send({ error: result.error.message });
  });
  for (const action of ["connect", "code", "cancel", "disconnect"] as const) {
    app.post(`${CLAUDE_AUTH_PATH}/${action}`, { bodyLimit: 8192 }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const principal = request.principal;
      if (
        principal?.kind !== "user" ||
        request.headers.origin !== appOrigin ||
        !request.headers["content-type"]?.startsWith("application/json")
      )
        return reply.code(403).send({ error: "owner_required" });
      const body = request.body;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => action !== "code" || key !== "code")
      )
        return reply.code(400).send({ error: "invalid_request" });
      const result =
        action === "code"
          ? "code" in body && typeof body.code === "string"
            ? await auth.code(task, principal.user.id, body.code)
            : null
          : await auth[action](task, principal.user.id);
      if (result === null) return reply.code(400).send({ error: "invalid_request" });
      return result.isOk()
        ? reply.send(result.value)
        : reply
            .code(result.error.code === "invalid_request" ? 400 : 503)
            .send({ error: result.error.message });
    });
  }
}
