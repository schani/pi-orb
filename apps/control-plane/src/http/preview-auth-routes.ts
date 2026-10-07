import type { FastifyInstance, FastifyRequest } from "fastify";
import { Result, ResultAsync } from "neverthrow";
import type { ApplicationAuth } from "../domain/application-auth.ts";
import { SESSION_COOKIE_NAME } from "../domain/application-auth.ts";
import {
  PREVIEW_AUTH_PREFIX,
  PREVIEW_CHALLENGE_COOKIE_NAME,
  PREVIEW_SESSION_COOKIE_NAME,
  type PreviewAuth,
  type PreviewIdentity,
} from "../domain/preview-auth.ts";
import { authCookie, requestCookie, sendAuthFailure } from "./auth-routes.ts";
import type { PreviewHosts } from "./preview-host.ts";

declare module "fastify" {
  interface FastifyRequest {
    previewIdentity?: PreviewIdentity;
  }
}
export interface PreviewAuthOptions {
  readonly hosts: PreviewHosts;
  readonly appOrigin: string;
  readonly applicationAuth: Pick<ApplicationAuth, "authenticateSession">;
  readonly previewAuth: PreviewAuth;
  readonly now?: () => number;
  readonly outcome?: (event: {
    event: "start" | "ticket" | "callback" | "admission";
    outcome: string;
    requestId: string;
  }) => void;
}
const parseUrl = Result.fromThrowable(
  (value: string) => new URL(value),
  () => "invalid_url",
);
function navigation(request: FastifyRequest): boolean {
  return (
    request.method === "GET" &&
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document" &&
    request.headers.upgrade === undefined
  );
}
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
function ticketBody(request: FastifyRequest) {
  return ResultAsync.fromPromise(
    (async () => {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request.raw.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 16384) return undefined;
        chunks.push(bytes);
      }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      return fields.size === 1 ? (fields.get("ticket") ?? undefined) : undefined;
    })(),
    () => "invalid_body",
  );
}
export function registerPreviewAuth(app: FastifyInstance, options: PreviewAuthOptions): void {
  const { hosts, appOrigin, previewAuth, applicationAuth } = options;
  const now = options.now ?? Date.now;
  const appHost = parseUrl(appOrigin)
    .map((url) => url.host)
    .unwrapOr("");
  app.decorateRequest("previewIdentity", undefined);
  app.addHook("onRequest", async (request, reply) => {
    const target = hosts.parse(request.headers.host);
    const parsed = parseUrl(`https://request.invalid${request.originalUrl}`);
    if (parsed.isErr()) return target ? sendAuthFailure(reply, "unauthenticated") : undefined;
    const url = parsed.value;
    const report = (event: "start" | "ticket" | "callback" | "admission", outcome: string) =>
      options.outcome?.({ event, outcome, requestId: request.id });
    if (!target) {
      if (request.headers.host !== appHost || url.pathname !== "/auth/preview") return;
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      if (request.method !== "GET") return sendAuthFailure(reply, "forbidden");
      const requestedOrigin = url.searchParams.get("origin") ?? "";
      const requested = parseUrl(requestedOrigin);
      const preview = requested.isOk() ? hosts.parse(requested.value.host) : undefined;
      const proof = url.searchParams.get("proof") ?? "";
      if (
        !preview ||
        requested.isErr() ||
        requested.value.href !== `${preview.origin}/` ||
        requestedOrigin !== preview.origin ||
        !/^[A-Za-z0-9_-]{1,256}$/u.test(proof)
      )
        return sendAuthFailure(reply, "forbidden");
      const identity = await applicationAuth.authenticateSession(
        appOrigin,
        requestCookie(request, SESSION_COOKIE_NAME),
      );
      if (identity.isErr()) {
        report("ticket", identity.error.type);
        if (identity.error.type !== "unauthenticated")
          return sendAuthFailure(reply, identity.error.type);
        return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(request.url)}`);
      }
      const ticket = await previewAuth.issue(preview.origin, proof, identity.value);
      report("ticket", ticket.isOk() ? "issued" : ticket.error.type);
      if (ticket.isErr()) return sendAuthFailure(reply, ticket.error.type);
      // Keep POST Origin intact; cross-origin Referer contains only the app origin.
      // The challenge is fresh entropy and safe as a CSP nonce; ticket material never enters a URL.
      return reply
        .header("referrer-policy", "strict-origin")
        .header(
          "content-security-policy",
          `default-src 'none'; script-src 'nonce-${proof}'; form-action ${preview.origin}; base-uri 'none'; frame-ancestors 'none'`,
        )
        .type("text/html")
        .send(
          `<form method="post" action="${escapeHtml(preview.origin)}${PREVIEW_AUTH_PREFIX}callback"><input type="hidden" name="ticket" value="${escapeHtml(ticket.value)}"><button>Continue</button></form><script nonce="${proof}">document.forms[0].submit()</script>`,
        );
    }
    if (url.pathname.startsWith("/__pi_orb/")) {
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      if (
        url.pathname === `${PREVIEW_AUTH_PREFIX}start` &&
        request.method === "GET" &&
        request.headers.upgrade === undefined
      ) {
        const started = await previewAuth.start(
          target.origin,
          url.searchParams.get("returnTo") ?? "/",
        );
        report("start", started.isOk() ? "started" : started.error.type);
        if (started.isErr()) return sendAuthFailure(reply, started.error.type);
        const cookie = authCookie(PREVIEW_CHALLENGE_COOKIE_NAME, started.value.cookie, 600);
        if (cookie.isErr()) return sendAuthFailure(reply, "internal");
        // SameSite=None is required for the cross-site POST callback; still Secure and host-only.
        return reply
          .header("set-cookie", cookie.value.replace("SameSite=Lax", "SameSite=None"))
          .redirect(
            `${appOrigin}/auth/preview?origin=${encodeURIComponent(target.origin)}&proof=${started.value.proof}`,
          );
      }
      const clear = authCookie(PREVIEW_CHALLENGE_COOKIE_NAME, "", 0);
      if (clear.isErr()) return sendAuthFailure(reply, "internal");
      reply.header("set-cookie", clear.value);
      if (
        url.pathname !== `${PREVIEW_AUTH_PREFIX}callback` ||
        request.method !== "POST" ||
        request.headers.origin !== appOrigin ||
        request.headers.upgrade !== undefined ||
        url.search !== "" ||
        request.headers["content-type"] !== "application/x-www-form-urlencoded"
      )
        return sendAuthFailure(reply, "unauthenticated");
      const body = await ticketBody(request);
      if (body.isErr() || !body.value) {
        reply.header("connection", "close");
        return sendAuthFailure(reply, "unauthenticated");
      }
      const completed = await previewAuth.complete(
        target.origin,
        requestCookie(request, PREVIEW_CHALLENGE_COOKIE_NAME),
        body.value,
      );
      report("callback", completed.isOk() ? "accepted" : completed.error.type);
      if (completed.isErr()) return sendAuthFailure(reply, completed.error.type);
      const cookie = authCookie(
        PREVIEW_SESSION_COOKIE_NAME,
        completed.value.cookie,
        Math.max(0, Math.floor((completed.value.expiresAt - now()) / 1000)),
      );
      if (cookie.isErr()) return sendAuthFailure(reply, "internal");
      return reply
        .header("set-cookie", [clear.value, cookie.value])
        .redirect(completed.value.returnTo);
    }
    const identity = await previewAuth.authenticate(
      target.origin,
      requestCookie(request, PREVIEW_SESSION_COOKIE_NAME),
    );
    if (identity.isOk()) {
      request.previewIdentity = identity.value;
      return;
    }
    report("admission", identity.error.type);
    if (identity.error.type === "unauthenticated" && navigation(request))
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .redirect(`${PREVIEW_AUTH_PREFIX}start?returnTo=${encodeURIComponent(request.url)}`);
    return sendAuthFailure(reply, identity.error.type);
  });
}
