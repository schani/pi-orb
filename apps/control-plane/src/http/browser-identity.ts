import type { FastifyInstance, FastifyRequest } from "fastify";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { type ApplicationAuth, LOGIN_COOKIE_NAME } from "../domain/application-auth.ts";
import type { PrincipalResolutionError, RequestPrincipal } from "../domain/identity.ts";
import {
  type AuthOrigins,
  type AuthOutcomeSink,
  authCookie,
  requestAuthOrigin,
  sendAuthFailure,
} from "./auth-routes.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal?: RequestPrincipal;
    authExpiresAt?: number;
  }
}

export type RequestPrincipalResolver = (
  request: FastifyRequest,
) => ResultAsync<
  RequestPrincipal,
  PrincipalResolutionError | { readonly type: "forbidden"; readonly message: string }
>;

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
  filesLogin?: {
    readonly origins: AuthOrigins;
    readonly auth: Pick<ApplicationAuth, "startLogin">;
    readonly outcome?: AuthOutcomeSink;
  },
): void {
  void app.register(async (scope) => {
    scope.decorateRequest("principal", undefined);
    scope.decorateRequest("authExpiresAt", undefined);
    scope.addHook("onRequest", async (request, reply) => {
      const principal = await resolve(request);
      if (principal.isOk()) {
        request.principal = principal.value;
        return;
      }
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      filesLogin?.outcome?.({
        event: "admission",
        outcome: principal.error.type,
        requestId: request.id,
      });
      if (principal.error.type === "forbidden") {
        return reply.status(403).send({
          error: { code: "forbidden", message: "Authentication forbidden", retryable: false },
        });
      }
      if (principal.error.type === "unauthenticated") {
        if (
          filesLogin &&
          requestAuthOrigin(request, filesLogin.origins) === filesLogin.origins.filesOrigin &&
          request.method === "GET" &&
          request.url.startsWith("/s/") &&
          request.headers.authorization === undefined &&
          request.headers["sec-fetch-mode"] === "navigate" &&
          request.headers["sec-fetch-dest"] === "document" &&
          request.headers.upgrade === undefined
        ) {
          const login = await filesLogin.auth.startLogin(
            filesLogin.origins.filesOrigin,
            request.url,
          );
          filesLogin.outcome?.({
            event: "files_login",
            outcome: login.isOk() ? "started" : login.error.type,
            requestId: request.id,
          });
          if (login.isErr()) return sendAuthFailure(reply, login.error.type);
          const cookie = authCookie(LOGIN_COOKIE_NAME, login.value.loginCookieValue, 600);
          if (cookie.isErr()) return sendAuthFailure(reply, "internal");
          return reply
            .header("cache-control", "no-store")
            .header("referrer-policy", "no-referrer")
            .header("set-cookie", cookie.value)
            .redirect(login.value.authorizationUrl);
        }
        return reply.status(401).send({
          error: { code: "unauthorized", message: "Authentication required", retryable: false },
        });
      }
      if (principal.error.type === "identity_unavailable") {
        return reply.status(503).send({
          error: { code: "unavailable", message: "Authentication unavailable", retryable: true },
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
