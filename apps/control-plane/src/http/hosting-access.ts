import type { FastifyInstance } from "fastify";
import { err, ok, Result, type Result as ResultType } from "neverthrow";

export interface HostingAccessConfig {
  readonly filesOrigin: string;
  readonly appOrigin: string;
  readonly runtimeOrigin?: string;
  readonly trustedLocalOrigins?: readonly string[];
  readonly trustedLocal?: boolean;
}

export interface HostingAccessRequest {
  readonly method: string;
  readonly path: string;
  /** The raw HTTP Host header. Callers must not substitute a forwarded-host header. */
  readonly host: string;
  readonly origin?: string;
  readonly secFetchSite?: string;
  readonly upgrade?: string;
}

export interface HostingAccessConfigError {
  readonly type: "hosting_access_config_error";
  readonly field: "filesOrigin" | "appOrigin" | "runtimeOrigin";
  readonly message: string;
}

export type HostingAccessDecision =
  | { readonly kind: "allow"; readonly surface: "hosted_read" | "app" }
  | { readonly kind: "isolated_not_found" }
  | {
      readonly kind: "reject";
      readonly reason:
        | "cross_site"
        | "files_method"
        | "files_websocket"
        | "files_wrong_host"
        | "invalid_host"
        | "unknown_host"
        | "untrusted_origin";
    };

export interface HostingAccessOutcome {
  readonly event: "hosting_denial";
  readonly reason: Extract<HostingAccessDecision, { kind: "reject" }>["reason"] | "files_route";
  readonly surface: "app" | "files" | "unknown";
  readonly requestId: string;
}

export type HostingAccessOutcomeSink = (outcome: HostingAccessOutcome) => void;

export interface HostingAccessPolicy {
  decide(request: HostingAccessRequest): HostingAccessDecision;
}

interface ParsedOrigin {
  readonly origin: string;
  readonly hostname: string;
  readonly host: string;
  readonly protocol: "http:" | "https:";
}

const parseUrl = Result.fromThrowable(
  (value: string) => new URL(value),
  () => undefined,
);

function parseOrigin(
  value: string,
  field: HostingAccessConfigError["field"],
): ResultType<ParsedOrigin, HostingAccessConfigError> {
  const parsed = parseUrl(value);
  if (parsed.isErr()) {
    return err({ type: "hosting_access_config_error", field, message: `${field} is not a URL` });
  }
  const url = parsed.value;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return err({
      type: "hosting_access_config_error",
      field,
      message: `${field} must be an exact http(s) origin`,
    });
  }
  return ok({
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    host: url.host.toLowerCase(),
    protocol: url.protocol,
  });
}

function requestHost(
  host: string,
  protocol: "http:" | "https:",
): { readonly host: string; readonly hostname: string } | null {
  if (host === "" || /[\\/?#@,\s]/u.test(host)) return null;
  const parsed = parseUrl(`${protocol}//${host}`);
  if (parsed.isErr()) return null;
  return {
    host: parsed.value.host.toLowerCase(),
    hostname: parsed.value.hostname.toLowerCase(),
  };
}

function requestPath(path: string): string {
  const query = path.indexOf("?");
  const hash = path.indexOf("#");
  const end = Math.min(query < 0 ? path.length : query, hash < 0 ? path.length : hash);
  return path.slice(0, end);
}

function isHostedPath(path: string): boolean {
  return /^\/s\/[^/]+\//u.test(path);
}

export function createHostingAccessPolicy(
  config: HostingAccessConfig,
): ResultType<HostingAccessPolicy, HostingAccessConfigError> {
  const files = parseOrigin(config.filesOrigin, "filesOrigin");
  if (files.isErr()) return err(files.error);
  const app = parseOrigin(config.appOrigin, "appOrigin");
  if (app.isErr()) return err(app.error);
  if (app.value.hostname === files.value.hostname)
    return err({
      type: "hosting_access_config_error",
      field: "appOrigin",
      message: "Origins must use separate hostnames",
    });

  const runtime = parseOrigin(config.runtimeOrigin ?? config.appOrigin, "runtimeOrigin");
  if (runtime.isErr()) return err(runtime.error);
  if (runtime.value.hostname === files.value.hostname)
    return err({
      type: "hosting_access_config_error",
      field: "runtimeOrigin",
      message: "Runtime and files origins must use separate hostnames",
    });

  const appHosts = new Set([app.value.host]);
  const appOrigins = new Set([app.value.origin]);
  for (const value of config.trustedLocalOrigins ?? []) {
    const local = parseOrigin(value, "appOrigin");
    if (local.isErr() || !["localhost", "127.0.0.1"].includes(local.value.hostname))
      return err({
        type: "hosting_access_config_error",
        field: "appOrigin",
        message: "Local aliases must be loopback origins",
      });
    appHosts.add(local.value.host);
    appOrigins.add(local.value.origin);
  }
  return ok({
    decide(request): HostingAccessDecision {
      const method = request.method.toUpperCase();
      const path = requestPath(request.path);
      const host = requestHost(request.host, files.value.protocol);
      if (host === null) return { kind: "reject", reason: "invalid_host" };

      if (host.host === files.value.host) {
        if (request.upgrade?.toLowerCase() === "websocket") {
          return { kind: "reject", reason: "files_websocket" };
        }
        if (method !== "GET" && method !== "HEAD") {
          return { kind: "reject", reason: "files_method" };
        }
        return isHostedPath(path) ||
          (method === "GET" && (path === "/auth/login" || path === "/auth/callback"))
          ? { kind: "allow", surface: "hosted_read" }
          : { kind: "isolated_not_found" };
      }

      const runtimeRequest = /^\/runtime(?:\/|$)/u.test(path);
      if (!appHosts.has(host.host) && !(runtimeRequest && host.host === runtime.value.host)) {
        return { kind: "reject", reason: "unknown_host" };
      }
      if (path === "/s" || path.startsWith("/s/")) {
        return { kind: "reject", reason: "files_wrong_host" };
      }

      const oauthCallback =
        method === "GET" &&
        (path === "/api/v1/mcp/oauth/callback" || path === "/auth/callback") &&
        request.upgrade === undefined;
      if (
        config.trustedLocal &&
        !oauthCallback &&
        request.origin !== undefined &&
        !appOrigins.has(request.origin)
      ) {
        return { kind: "reject", reason: "untrusted_origin" };
      }
      return { kind: "allow", surface: "app" };
    },
  });
}

export function registerHostingAccessGuard(
  app: FastifyInstance,
  policy: HostingAccessPolicy,
  dashboardUrl: string,
  outcome?: HostingAccessOutcomeSink,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const decision = policy.decide({
      method: request.method,
      path: request.raw.url ?? request.url,
      host: request.headers.host ?? "",
      ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
      ...(request.headers["sec-fetch-site"] === undefined
        ? {}
        : { secFetchSite: request.headers["sec-fetch-site"] }),
      ...(request.headers.upgrade === undefined ? {} : { upgrade: request.headers.upgrade }),
    });
    if (decision.kind === "allow") return;
    const reason = decision.kind === "isolated_not_found" ? "files_route" : decision.reason;
    const surface =
      reason === "invalid_host" || reason === "unknown_host"
        ? "unknown"
        : reason === "files_method" || reason === "files_websocket" || reason === "files_route"
          ? "files"
          : "app";
    outcome?.({ event: "hosting_denial", reason, surface, requestId: request.id });
    if (decision.kind === "isolated_not_found") {
      return reply
        .status(404)
        .type("text/html")
        .send(`<p>Hosted resource doesn't exist.</p><a href="${dashboardUrl}">Dashboard</a>`);
    }
    return reply.status(403).send({ error: { code: "forbidden" } });
  });
}
