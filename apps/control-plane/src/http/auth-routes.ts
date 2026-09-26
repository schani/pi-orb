import { parse, serialize } from "cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Result } from "neverthrow";
import type { ApplicationAuth } from "../domain/application-auth.ts";
import { LOGIN_COOKIE_NAME, SESSION_COOKIE_NAME } from "../domain/application-auth.ts";

export interface AuthOrigins {
  readonly appOrigin: string;
  readonly filesOrigin: string;
}
export type AuthOutcomeSink = (event: {
  readonly event: "login" | "callback" | "logout" | "files_login" | "admission";
  readonly outcome: string;
  readonly requestId: string;
}) => void;
export function requestAuthOrigin(
  request: FastifyRequest,
  origins: AuthOrigins,
): string | undefined {
  return [origins.appOrigin, origins.filesOrigin].find(
    (origin) =>
      Result.fromThrowable(
        () => new URL(origin).host,
        () => "invalid_origin",
      )().unwrapOr("") === request.headers.host,
  );
}
export const authCookie = Result.fromThrowable(
  (name: string, value: string, maxAge: number) =>
    serialize(name, value, { secure: true, httpOnly: true, sameSite: "lax", path: "/", maxAge }),
  () => ({ type: "internal" as const }),
);
export function requestCookie(request: FastifyRequest, name: string): string {
  return Result.fromThrowable(
    () => parse(request.headers.cookie ?? "")[name] ?? "",
    () => "invalid_cookie",
  )().unwrapOr("");
}
export function sendAuthFailure(reply: FastifyReply, type: string) {
  const status =
    type === "identity_unavailable"
      ? 503
      : type === "forbidden"
        ? 403
        : type === "unauthenticated"
          ? 401
          : 500;
  const code =
    status === 503
      ? "unavailable"
      : status === 403
        ? "forbidden"
        : status === 401
          ? "unauthorized"
          : "internal";
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .status(status)
    .send({ error: { code, message: `Authentication ${code}`, retryable: status === 503 } });
}
export function registerAuthRoutes(
  app: FastifyInstance,
  origins: AuthOrigins,
  auth: Pick<ApplicationAuth, "startLogin" | "completeLogin">,
  outcome: AuthOutcomeSink = () => {},
): void {
  app.get<{ Querystring: { returnTo?: string } }>(
    "/auth/login",
    { logLevel: "silent", exposeHeadRoute: false },
    async (request, reply) => {
      const origin = requestAuthOrigin(request, origins);
      if (origin === undefined) return sendAuthFailure(reply, "forbidden");
      const returnTo = typeof request.query.returnTo === "string" ? request.query.returnTo : "/";
      if (origin === origins.filesOrigin && !/^\/s\/[^/]+\//u.test(returnTo))
        return sendAuthFailure(reply, "unauthenticated");
      const result = await auth.startLogin(origin, returnTo);
      outcome({
        event: "login",
        outcome: result.isOk() ? "started" : result.error.type,
        requestId: request.id,
      });
      if (result.isErr()) return sendAuthFailure(reply, result.error.type);
      const cookie = authCookie(LOGIN_COOKIE_NAME, result.value.loginCookieValue, 600);
      if (cookie.isErr()) return sendAuthFailure(reply, "internal");
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("set-cookie", cookie.value)
        .redirect(result.value.authorizationUrl);
    },
  );
  app.get(
    "/auth/callback",
    { logLevel: "silent", exposeHeadRoute: false },
    async (request, reply) => {
      const origin = requestAuthOrigin(request, origins);
      if (origin === undefined) return sendAuthFailure(reply, "forbidden");
      const result = await auth.completeLogin(
        origin,
        origin + request.url,
        requestCookie(request, LOGIN_COOKIE_NAME),
      );
      outcome({
        event: "callback",
        outcome: result.isOk() ? "accepted" : result.error.type,
        requestId: request.id,
      });
      const clear = authCookie(LOGIN_COOKIE_NAME, "", 0);
      if (clear.isErr()) return sendAuthFailure(reply, "internal");
      reply.header("set-cookie", clear.value);
      if (result.isErr()) return sendAuthFailure(reply, result.error.type);
      if (origin === origins.filesOrigin && !/^\/s\/[^/]+\//u.test(result.value.returnTo))
        return sendAuthFailure(reply, "unauthenticated");
      const cookie = authCookie(SESSION_COOKIE_NAME, result.value.sessionCookieValue, 43200);
      if (cookie.isErr()) return sendAuthFailure(reply, "internal");
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("set-cookie", [cookie.value, clear.value])
        .redirect(result.value.returnTo);
    },
  );
  app.post("/auth/logout", async (request, reply) => {
    const origin = requestAuthOrigin(request, origins);
    if (origin === origins.filesOrigin)
      return reply.code(404).send({
        error: { code: "not_found", message: "Resource doesn't exist", retryable: false },
      });
    if (origin !== origins.appOrigin || request.headers.origin !== origins.appOrigin)
      return sendAuthFailure(reply, "forbidden");
    outcome({ event: "logout", outcome: "cleared", requestId: request.id });
    const cookie = authCookie(SESSION_COOKIE_NAME, "", 0);
    if (cookie.isErr()) return sendAuthFailure(reply, "internal");
    return reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("set-cookie", cookie.value)
      .code(204)
      .send();
  });
}
