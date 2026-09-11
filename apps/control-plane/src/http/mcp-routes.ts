import { McpCatalogSchema, type McpConfig, McpConfigSchema } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Result } from "neverthrow";
import { Check } from "typebox/value";
import type { McpConfigError, McpStore } from "../domain/mcp.ts";

export function sendMcpError(reply: FastifyReply, error: McpConfigError) {
  return reply.status({ not_found: 404, conflict: 409, unavailable: 503 }[error.code]).send({
    error: { code: error.code, message: error.message, retryable: error.code === "unavailable" },
  });
}
export function registerMcpRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  store: McpStore,
  describe?: (
    projectId: string,
    config: McpConfig,
  ) => Promise<Result<{ description: string }, string>>,
): void {
  if (describe)
    app.post<{ Params: { projectId: string } }>(
      "/api/v1/projects/:projectId/mcp/describe",
      async (request, reply) => {
        const project = await store.read(task, request.params.projectId);
        if (project.isErr()) return sendMcpError(reply, project.error);
        if (!Check(McpConfigSchema, request.body))
          return reply.status(400).send({
            error: {
              code: "invalid_request",
              message: "Invalid MCP configuration",
              retryable: false,
            },
          });
        const result = await describe(request.params.projectId, request.body);
        reply.header("cache-control", "no-store");
        return result.isOk()
          ? reply.send(result.value)
          : reply.status(400).send({
              error: { code: "invalid_request", message: result.error, retryable: false },
            });
      },
    );
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/mcp",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const result = await store.read(task, request.params.projectId);
      return result.isErr() ? sendMcpError(reply, result.error) : reply.send(result.value);
    },
  );
  app.put<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/mcp",
    async (request, reply) => {
      if (
        !Check(McpCatalogSchema, request.body) ||
        new Set(request.body.servers.map((c) => c.name)).size !== request.body.servers.length ||
        new Set(request.body.servers.flatMap((c) => (c.oauth ? [c.oauth.id] : []))).size !==
          request.body.servers.filter((c) => c.oauth).length ||
        request.body.servers.some(
          (c) =>
            c.oauth &&
            Object.keys(c.headers).some((name) => name.toLowerCase() === "authorization"),
        )
      ) {
        return reply.status(400).send({
          error: {
            code: "invalid_request",
            message: "Invalid MCP configuration or duplicate server names",
            retryable: false,
          },
        });
      }
      for (const server of request.body.servers) {
        const valid = Result.fromThrowable(
          () => new URL(server.url),
          () => "Invalid MCP URL",
        )();
        if (valid.isErr() || valid.value.username || valid.value.password || valid.value.hash)
          return reply.status(400).send({
            error: {
              code: "invalid_request",
              message: "Invalid MCP URL; credentials and fragments are not allowed",
              retryable: false,
            },
          });
      }
      reply.header("cache-control", "no-store");
      const result = await store.replace(task, request.params.projectId, request.body);
      return result.isErr() ? sendMcpError(reply, result.error) : reply.send(result.value);
    },
  );
}
