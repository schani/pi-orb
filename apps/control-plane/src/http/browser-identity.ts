import type { FastifyInstance, FastifyRequest } from "fastify";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { PrincipalResolutionError, RequestPrincipal } from "../domain/identity.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal?: RequestPrincipal;
  }
}

export type RequestPrincipalResolver = (
  request: FastifyRequest,
) => ResultAsync<RequestPrincipal, PrincipalResolutionError>;

export function requirePrincipal(
  request: FastifyRequest,
): Result<RequestPrincipal, { readonly type: "principal_missing" }> {
  return request.principal === undefined
    ? err({ type: "principal_missing" })
    : ok(request.principal);
}

export function registerAuthenticatedBrowserRoutes(
  app: FastifyInstance,
  resolve: RequestPrincipalResolver,
  register: (scope: FastifyInstance) => Promise<void> | void,
): void {
  void app.register(async (scope) => {
    scope.decorateRequest("principal", undefined);
    scope.addHook("onRequest", async (request, reply) => {
      const principal = await resolve(request);
      if (principal.isOk()) {
        request.principal = principal.value;
        return;
      }
      if (principal.error.type === "unauthenticated") {
        return reply.status(401).send({
          error: { code: "unauthorized", message: principal.error.message, retryable: false },
        });
      }
      if (principal.error.type === "identity_unavailable") {
        return reply.status(503).send({
          error: { code: "unavailable", message: principal.error.message, retryable: true },
        });
      }
      if (principal.error.code === "unavailable") {
        return reply.status(503).send({
          error: { code: "unavailable", message: "identity store unavailable", retryable: true },
        });
      }
      return reply.status(500).send({
        error: { code: "internal", message: "identity resolution failed", retryable: false },
      });
    });
    await register(scope);
  });
}
