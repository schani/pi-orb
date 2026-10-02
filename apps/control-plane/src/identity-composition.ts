import type { SimulationTask } from "determined";
import { err, errAsync, ok, Result } from "neverthrow";
import type { ApplicationAuth } from "./domain/application-auth.ts";
import { SESSION_COOKIE_NAME } from "./domain/application-auth.ts";
import {
  fixedUserIdentityVerifier,
  resolveUserPrincipal,
  type UserIdSource,
  type UserStore,
} from "./domain/identity.ts";
import { type AuthOrigins, requestAuthOrigin, requestCookie } from "./http/auth-routes.ts";
import type { RequestPrincipalResolver } from "./http/browser-identity.ts";

export type RequestIdentityConfig =
  | { readonly kind: "local" }
  | ({
      readonly kind: "google";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly cookieSecret: string;
      readonly machineSubject: string;
    } & AuthOrigins);
export function readRequestIdentityConfig(
  environment: Readonly<Record<string, string | undefined>>,
): Result<RequestIdentityConfig, string> {
  if (environment.PI_ORB_AUTH_MODE === "local")
    return environment.K_SERVICE !== undefined
      ? err("Local authentication is forbidden in Cloud Run")
      : ok({ kind: "local" });
  if (environment.PI_ORB_AUTH_MODE !== "google")
    return err("PI_ORB_AUTH_MODE must be local or google");
  const fields = {
    clientId: "PI_ORB_GOOGLE_CLIENT_ID",
    clientSecret: "PI_ORB_GOOGLE_CLIENT_SECRET",
    cookieSecret: "PI_ORB_COOKIE_SECRET",
    machineSubject: "PI_ORB_MACHINE_SUBJECT",
    appOrigin: "PI_ORB_APP_ORIGIN",
    filesOrigin: "PI_ORB_HOSTING_ORIGIN",
  } as const;
  for (const key of Object.values(fields))
    if (!environment[key]?.trim()) return err(`${key} is required`);
  if ((environment[fields.cookieSecret] ?? "").length < 32)
    return err("PI_ORB_COOKIE_SECRET must contain at least 32 characters");
  const parse = Result.fromThrowable(
    (value: string) => new URL(value),
    () => "Invalid authentication origin",
  );
  const app = parse(environment[fields.appOrigin] ?? "");
  const files = parse(environment[fields.filesOrigin] ?? "");
  for (const origin of [app, files]) {
    if (
      origin.isErr() ||
      origin.value.protocol !== "https:" ||
      origin.value.origin !== environment[origin === app ? fields.appOrigin : fields.filesOrigin] ||
      origin.value.username ||
      origin.value.password
    )
      return err("Authentication origins must be exact HTTPS origins");
  }
  if (app.isErr() || files.isErr() || app.value.hostname === files.value.hostname)
    return err("Authentication origins must have different hostnames");
  return ok({
    kind: "google",
    clientId: (environment[fields.clientId] ?? "").trim(),
    clientSecret: (environment[fields.clientSecret] ?? "").trim(),
    cookieSecret: environment[fields.cookieSecret] ?? "",
    machineSubject: (environment[fields.machineSubject] ?? "").trim(),
    appOrigin: environment[fields.appOrigin] ?? "",
    filesOrigin: environment[fields.filesOrigin] ?? "",
  });
}
export function createGoogleRequestPrincipalResolver(
  origins: AuthOrigins,
  auth: Pick<ApplicationAuth, "authenticateSession" | "authenticateMachine">,
): RequestPrincipalResolver {
  return (request) => {
    const origin = requestAuthOrigin(request, origins);
    if (origin === undefined) return errAsync({ type: "forbidden", message: "Untrusted host" });
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      if (origin !== origins.appOrigin || !/^Bearer [^\s]+$/u.test(authorization))
        return errAsync({ type: "unauthenticated", message: "Invalid credential" });
      return auth.authenticateMachine(authorization.slice(7));
    }
    const unsafe =
      !["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.upgrade !== undefined;
    const callback =
      request.method === "GET" &&
      request.url.split("?")[0] === "/api/v1/mcp/oauth/callback" &&
      request.headers.upgrade === undefined;
    if (
      !callback &&
      ((unsafe && request.headers.origin !== origin) ||
        (request.headers.origin !== undefined && request.headers.origin !== origin))
    )
      return errAsync({ type: "forbidden", message: "Untrusted origin" });
    const cookie = requestCookie(request, SESSION_COOKIE_NAME);
    if (!cookie) return errAsync({ type: "unauthenticated", message: "Session required" });
    return auth.authenticateSession(origin, cookie).map((session) => {
      request.authExpiresAt = session.expiresAt;
      return session.principal;
    });
  };
}
export function createRequestPrincipalResolver(
  task: SimulationTask,
  config: RequestIdentityConfig,
  users: UserStore,
  ids: UserIdSource,
  auth?: ApplicationAuth,
): Result<RequestPrincipalResolver, string> {
  if (config.kind === "google")
    return auth
      ? ok(createGoogleRequestPrincipalResolver(config, auth))
      : err("Application authentication is required");
  const verifier = fixedUserIdentityVerifier({
    issuer: "pi-orb:local",
    subject: "developer",
    email: null,
  });
  return ok((request) => resolveUserPrincipal(task, verifier, users, ids, request));
}
