import type { SimulationTask } from "determined";
import { errAsync, okAsync, Result, type ResultAsync } from "neverthrow";
import type {
  IdentityVerificationError,
  RequestPrincipal,
  User,
  UserIdSource,
  UserStore,
  VerifiedUserIdentity,
} from "./identity.ts";

export const LOGIN_COOKIE_NAME = "__Host-pi-orb-login";
export const SESSION_COOKIE_NAME = "__Host-pi-orb-session";
export const LOGIN_LIFETIME_MS = 10 * 60_000;
export const SESSION_LIFETIME_MS = 12 * 60 * 60_000;
export const LOGIN_CALLBACK_PATH = "/auth/callback";
type Failure = IdentityVerificationError;
export type OpsPrincipal = Extract<RequestPrincipal, { kind: "ops" }>;
export interface LoginMaterial {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}
export interface GoogleLoginProvider {
  start(
    task: SimulationTask,
    callbackUrl: string,
  ): ResultAsync<LoginMaterial & { authorizationUrl: string }, Failure>;
  complete(
    task: SimulationTask,
    callbackUrl: string,
    material: LoginMaterial,
  ): ResultAsync<VerifiedUserIdentity, Failure>;
}
export interface SealedCookies {
  seal(value: unknown): ResultAsync<string, Failure>;
  unseal(value: string): ResultAsync<unknown, Failure>;
}
export interface MachineTokenVerifier {
  verify(token: string): ResultAsync<OpsPrincipal, Failure>;
}
export interface ApplicationAuth {
  startLogin(
    origin: string,
    returnTo: string,
  ): ResultAsync<{ authorizationUrl: string; loginCookieValue: string }, Failure>;
  completeLogin(
    origin: string,
    callbackUrl: string,
    loginCookieValue: string,
  ): ResultAsync<{ sessionCookieValue: string; returnTo: string }, Failure>;
  authenticateSession(
    origin: string,
    cookieValue: string,
  ): ResultAsync<
    { principal: Extract<RequestPrincipal, { kind: "user" }>; expiresAt: number },
    Failure
  >;
  authenticateMachine(token: string): ResultAsync<OpsPrincipal, Failure>;
}
export interface ApplicationAuthDeps {
  readonly task: SimulationTask;
  readonly users: UserStore;
  readonly ids: UserIdSource;
  readonly cookies: SealedCookies;
  readonly provider: GoogleLoginProvider;
  readonly machine: MachineTokenVerifier;
  readonly origins: readonly string[];
}
const denied = (): Failure => ({
  type: "unauthenticated",
  message: "Invalid or expired authentication",
});
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function localPath(path: string): boolean {
  return (
    path.length <= 1024 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject URL whitespace and control-character normalization.
    !/[\\\u0000-\u0020\u007f]/u.test(path)
  );
}
function user(value: unknown): value is User {
  return (
    record(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.email === null || typeof value.email === "string")
  );
}
export function createApplicationAuth(deps: ApplicationAuthDeps): ApplicationAuth {
  const { task, cookies, provider } = deps;
  const bound = (
    value: unknown,
    origin: string,
    purpose: string,
  ): value is Record<string, unknown> & { expiresAt: number } =>
    deps.origins.includes(origin) &&
    record(value) &&
    value.origin === origin &&
    value.purpose === purpose &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    task.wallNow() < value.expiresAt;
  return {
    startLogin(origin, returnTo) {
      if (!deps.origins.includes(origin) || !localPath(returnTo)) return errAsync(denied());
      return provider.start(task, origin + LOGIN_CALLBACK_PATH).andThen((material) =>
        cookies
          .seal({
            purpose: "login",
            origin,
            expiresAt: task.wallNow() + LOGIN_LIFETIME_MS,
            returnTo,
            state: material.state,
            nonce: material.nonce,
            codeVerifier: material.codeVerifier,
          })
          .map((loginCookieValue) => ({
            authorizationUrl: material.authorizationUrl,
            loginCookieValue,
          })),
      );
    },
    completeLogin(origin, callbackUrl, loginCookieValue) {
      const url = Result.fromThrowable(() => new URL(callbackUrl), denied)();
      if (
        url.isErr() ||
        url.value.origin !== origin ||
        url.value.pathname !== LOGIN_CALLBACK_PATH ||
        url.value.username ||
        url.value.password ||
        url.value.hash
      )
        return errAsync(denied());
      return cookies.unseal(loginCookieValue).andThen((value) => {
        if (
          !bound(value, origin, "login") ||
          typeof value.returnTo !== "string" ||
          !localPath(value.returnTo) ||
          typeof value.state !== "string" ||
          typeof value.nonce !== "string" ||
          typeof value.codeVerifier !== "string"
        )
          return errAsync(denied());
        const returnTo = value.returnTo;
        return provider
          .complete(task, callbackUrl, {
            state: value.state,
            nonce: value.nonce,
            codeVerifier: value.codeVerifier,
          })
          .andThen((identity) => {
            const id = deps.ids.next();
            if (id.isErr()) return errAsync(id.error);
            return deps.users
              .resolveUser(task, identity, { id: id.value, now: task.wallNow() })
              .mapErr(
                (): Failure => ({
                  type: "identity_unavailable",
                  message: "Identity persistence unavailable; start a new login",
                }),
              );
          })
          .andThen((resolvedUser) =>
            cookies.seal({
              purpose: "session",
              origin,
              user: resolvedUser,
              expiresAt: task.wallNow() + SESSION_LIFETIME_MS,
            }),
          )
          .map((sessionCookieValue) => ({ sessionCookieValue, returnTo }));
      });
    },
    authenticateSession(origin, cookieValue) {
      return cookies.unseal(cookieValue).andThen((value) =>
        bound(value, origin, "session") && user(value.user)
          ? okAsync({
              principal: { kind: "user" as const, user: value.user },
              expiresAt: value.expiresAt,
            })
          : errAsync(denied()),
      );
    },
    authenticateMachine: (token) => deps.machine.verify(token),
  };
}
