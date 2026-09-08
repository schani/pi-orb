import type { FastifyInstance } from "fastify";
import { err, ok, Result, type Result as ResultType } from "neverthrow";

export interface HostingAccessConfig {
  readonly filesOrigin: string;
  /** Explicit browser development origins, such as the Vite server. */
  readonly trustedBrowserOrigins?: readonly string[];
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
  readonly field: "filesOrigin" | "trustedBrowserOrigins";
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

function isProtectedAppRequest(path: string, upgrade: string | undefined): boolean {
  return (
    upgrade?.toLowerCase() === "websocket" ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/runtime" ||
    path.startsWith("/runtime/") ||
    path.startsWith("/.well-known/")
  );
}

export function createHostingAccessPolicy(
  config: HostingAccessConfig,
): ResultType<HostingAccessPolicy, HostingAccessConfigError> {
  const files = parseOrigin(config.filesOrigin, "filesOrigin");
  if (files.isErr()) return err(files.error);
  const trusted = new Set<string>();
  for (const value of config.trustedBrowserOrigins ?? []) {
    const parsed = parseOrigin(value, "trustedBrowserOrigins");
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value.hostname === files.value.hostname) {
      return err({
        type: "hosting_access_config_error",
        field: "trustedBrowserOrigins",
        message: "filesOrigin cannot be a trusted browser origin",
      });
    }
    trusted.add(parsed.value.origin);
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
        return isHostedPath(path)
          ? { kind: "allow", surface: "hosted_read" }
          : { kind: "isolated_not_found" };
      }

      if (host.hostname === files.value.hostname) {
        return { kind: "reject", reason: "unknown_host" };
      }
      if (path === "/s" || path.startsWith("/s/")) {
        return { kind: "reject", reason: "files_wrong_host" };
      }

      if (isProtectedAppRequest(path, request.upgrade)) {
        if (request.origin !== undefined) {
          const origin = parseOrigin(request.origin, "trustedBrowserOrigins");
          if (origin.isErr()) return { kind: "reject", reason: "untrusted_origin" };
          const expected = `${files.value.protocol}//${host.host}`;
          if (origin.value.origin !== expected && !trusted.has(origin.value.origin)) {
            return { kind: "reject", reason: "untrusted_origin" };
          }
        } else if (request.secFetchSite?.toLowerCase() === "cross-site") {
          return { kind: "reject", reason: "cross_site" };
        }
      }
      return { kind: "allow", surface: "app" };
    },
  });
}

export function registerHostingAccessGuard(
  app: FastifyInstance,
  policy: HostingAccessPolicy,
  dashboardUrl: string,
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
    if (decision.kind === "isolated_not_found") {
      return reply
        .status(404)
        .type("text/html")
        .send(`<p>Hosted resource doesn't exist.</p><a href="${dashboardUrl}">Dashboard</a>`);
    }
    return reply.status(403).send({ error: { code: "forbidden" } });
  });
}
