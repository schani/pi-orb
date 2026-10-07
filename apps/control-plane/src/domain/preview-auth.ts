import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import type { SealedCookies } from "./application-auth.ts";
import type { IdentityVerificationError, RequestPrincipal } from "./identity.ts";

export const PREVIEW_SESSION_COOKIE_NAME = "__Host-pi-orb-preview";
export const PREVIEW_CHALLENGE_COOKIE_NAME = "__Host-pi-orb-preview-challenge";
export const PREVIEW_AUTH_PREFIX = "/__pi_orb/auth/";
export const PREVIEW_TICKET_LIFETIME_MS = 60_000;
export const PREVIEW_CHALLENGE_LIFETIME_MS = 10 * 60_000;
export interface PreviewIdentity {
  readonly principal: Extract<RequestPrincipal, { kind: "user" }>;
  readonly expiresAt: number;
}
export interface PreviewAuth {
  start(
    origin: string,
    returnTo: string,
  ): ResultAsync<{ cookie: string; proof: string }, IdentityVerificationError>;
  issue(
    origin: string,
    proof: string,
    identity: PreviewIdentity,
  ): ResultAsync<string, IdentityVerificationError>;
  complete(
    origin: string,
    challengeCookie: string,
    ticket: string,
  ): ResultAsync<
    { cookie: string; returnTo: string; expiresAt: number },
    IdentityVerificationError
  >;
  authenticate(
    origin: string,
    cookie: string,
  ): ResultAsync<PreviewIdentity, IdentityVerificationError>;
}
const denied = (): IdentityVerificationError => ({
  type: "unauthenticated",
  message: "Invalid or expired preview authentication",
});
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function principal(value: unknown): value is PreviewIdentity["principal"] {
  return (
    record(value) &&
    value.kind === "user" &&
    record(value.user) &&
    typeof value.user.id === "string" &&
    value.user.id.length > 0 &&
    (value.user.email === null || typeof value.user.email === "string")
  );
}
export function createPreviewAuth(deps: {
  cookies: SealedCookies;
  now(): number;
  challenge(): Result<string, IdentityVerificationError>;
}): PreviewAuth {
  const { cookies } = deps;
  const bound = (
    value: unknown,
    origin: string,
    purpose: string,
  ): value is Record<string, unknown> & { expiresAt: number } =>
    record(value) &&
    value.origin === origin &&
    value.purpose === purpose &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > deps.now();
  return {
    start(origin, returnTo) {
      if (
        !returnTo.startsWith("/") ||
        returnTo.startsWith("//") ||
        returnTo.startsWith(PREVIEW_AUTH_PREFIX) ||
        returnTo.length > 4096 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: prevent URL normalization and header injection.
        /[\\\u0000-\u0020\u007f]/u.test(returnTo)
      )
        return errAsync(denied());
      const generated = deps.challenge();
      if (generated.isErr()) return errAsync(generated.error);
      const proof = generated.value;
      return cookies
        .seal({
          purpose: "preview-challenge",
          origin,
          proof,
          returnTo,
          expiresAt: deps.now() + PREVIEW_CHALLENGE_LIFETIME_MS,
        })
        .map((cookie) => ({ cookie, proof }));
    },
    issue(origin, proof, identity) {
      if (
        !principal(identity.principal) ||
        !Number.isFinite(identity.expiresAt) ||
        identity.expiresAt <= deps.now() ||
        !/^[A-Za-z0-9_-]{1,256}$/u.test(proof)
      )
        return errAsync(denied());
      return cookies.seal({
        purpose: "preview-ticket",
        origin,
        proof,
        principal: identity.principal,
        sessionExpiresAt: identity.expiresAt,
        expiresAt: Math.min(identity.expiresAt, deps.now() + PREVIEW_TICKET_LIFETIME_MS),
      });
    },
    complete(origin, challengeCookie, ticket) {
      return cookies.unseal(challengeCookie).andThen((challenge) => {
        if (
          !bound(challenge, origin, "preview-challenge") ||
          typeof challenge.returnTo !== "string" ||
          typeof challenge.proof !== "string"
        )
          return errAsync(denied());
        const returnTo = challenge.returnTo;
        return cookies.unseal(ticket).andThen((value) => {
          if (
            !bound(value, origin, "preview-ticket") ||
            value.proof !== challenge.proof ||
            !principal(value.principal) ||
            typeof value.sessionExpiresAt !== "number" ||
            !Number.isFinite(value.sessionExpiresAt) ||
            value.sessionExpiresAt <= deps.now()
          )
            return errAsync(denied());
          const expiresAt = value.sessionExpiresAt;
          return cookies
            .seal({ purpose: "preview-session", origin, principal: value.principal, expiresAt })
            .map((cookie) => ({ cookie, returnTo, expiresAt }));
        });
      });
    },
    authenticate(origin, cookie) {
      return cookies
        .unseal(cookie)
        .andThen((value) =>
          bound(value, origin, "preview-session") && principal(value.principal)
            ? okAsync({ principal: value.principal, expiresAt: value.expiresAt })
            : errAsync(denied()),
        );
    },
  };
}
