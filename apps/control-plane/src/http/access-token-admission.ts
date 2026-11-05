import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errAsync, Result } from "neverthrow";
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
  type AccessTokenDeps,
  verifyAccessToken,
} from "../domain/access-token.ts";
import { requestCookie, sendAuthFailure } from "./auth-routes.ts";
import type { RequestPrincipalResolver } from "./browser-identity.ts";
import type {} from "./preview-auth-routes.ts";
import type { PreviewHosts } from "./preview-host.ts";

const invalid = { type: "unauthenticated", message: "Invalid access token" } as const;
/** The header wins over the cookie; neither ever reaches the preview application. */
export function presentedAccessToken(request: FastifyRequest): string | string[] | undefined {
  return (
    request.headers[ACCESS_TOKEN_HEADER] ??
    (requestCookie(request, ACCESS_TOKEN_COOKIE) || undefined)
  );
}
const owner = (ownerUserId: string) => ({
  kind: "user" as const,
  user: { id: ownerUserId, email: null },
});

/** Runs before preview login, so a presented token is never redirected into Google login. */
export function registerPreviewAccessTokens(
  app: FastifyInstance,
  task: SimulationTask,
  options: {
    readonly hosts: PreviewHosts;
    readonly tokens: AccessTokenDeps;
    readonly outcome?: (event: { outcome: string; requestId: string }) => void;
  },
): void {
  if (!app.hasRequestDecorator("previewIdentity"))
    app.decorateRequest("previewIdentity", undefined);
  app.addHook("onRequest", async (request, reply) => {
    const token = presentedAccessToken(request);
    const target = options.hosts.parse(request.headers.host);
    if (token === undefined || !target) return;
    const identity =
      typeof token === "string"
        ? await verifyAccessToken(task, options.tokens, token, target.orbId)
        : await errAsync(invalid);
    if (identity.isErr()) {
      options.outcome?.({ outcome: `token_${identity.error.type}`, requestId: request.id });
      return sendAuthFailure(reply, identity.error.type);
    }
    request.previewIdentity = {
      principal: owner(identity.value.ownerUserId),
      expiresAt: identity.value.expiresAt,
    };
  });
}

/** A presented token is the files host's only credential for that request and never falls back. */
export function withFilesAccessTokens(
  resolve: RequestPrincipalResolver,
  task: SimulationTask,
  options: { readonly filesOrigin: string; readonly tokens: AccessTokenDeps },
): RequestPrincipalResolver {
  const filesHost = Result.fromThrowable(
    () => new URL(options.filesOrigin).host,
    () => "invalid_origin",
  )().unwrapOr("");
  return (request) => {
    const token = presentedAccessToken(request);
    if (token === undefined) return resolve(request);
    const orbId = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//u.exec(
      request.url,
    )?.[1];
    if (request.headers.host !== filesHost || typeof token !== "string" || orbId === undefined)
      return errAsync(invalid);
    return verifyAccessToken(task, options.tokens, token, orbId).map((identity) => {
      request.authExpiresAt = identity.expiresAt;
      return owner(identity.ownerUserId);
    });
  };
}
