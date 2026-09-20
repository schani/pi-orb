import { NoSimulationTask } from "determined";
import { OAuth2Client } from "google-auth-library";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import * as oidc from "openid-client";
import type { GoogleLoginProvider, MachineTokenVerifier } from "../domain/application-auth.ts";
import type { IdentityVerificationError, VerifiedUserIdentity } from "../domain/identity.ts";
import {
  type GoogleKeyFetcher,
  type GoogleKeyProviderOutcome,
  GoogleMachineKeys,
} from "./google-machine-keys.ts";

export const GOOGLE_ISSUER = "https://accounts.google.com";
const unavailable = (): IdentityVerificationError => ({
  type: "identity_unavailable",
  message: "Google authentication unavailable; start a new login",
});
const invalid = (): IdentityVerificationError => ({
  type: "unauthenticated",
  message: "Invalid Google authentication",
});
function providerFailure(error: unknown): IdentityVerificationError {
  if (error instanceof oidc.AuthorizationResponseError || error instanceof oidc.ResponseBodyError)
    return [
      "access_denied",
      "invalid_grant",
      "login_required",
      "interaction_required",
      "consent_required",
      "account_selection_required",
    ].includes(error.error)
      ? invalid()
      : unavailable();
  return error instanceof oidc.ClientError &&
    error.code !== "OAUTH_TIMEOUT" &&
    error.code !== "OAUTH_RESPONSE_IS_NOT_CONFORM"
    ? invalid()
    : unavailable();
}
export function admittedGoogleIdentity(
  claims: Record<string, unknown>,
  clientId: string,
  now: number,
  issuer: string = GOOGLE_ISSUER,
): Result<VerifiedUserIdentity, IdentityVerificationError> {
  if (
    claims.iss !== issuer ||
    claims.aud !== clientId ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= now
  )
    return err(invalid());
  if (
    claims.email_verified !== true ||
    claims.hd !== "heyglide.com" ||
    typeof claims.email !== "string" ||
    !claims.email
  )
    return err({ type: "forbidden", message: "Workspace membership required" });
  return ok({ issuer, subject: claims.sub, email: claims.email });
}
/** Google endpoints are fixed; tests inject the domain provider port instead. */
export interface GoogleLoginTransport {
  readonly metadata?: oidc.ServerMetadata;
  readonly customFetch?: oidc.CustomFetch;
}
export function createGoogleLoginProvider(
  input: { clientId: string; clientSecret: string },
  transport: GoogleLoginTransport = {},
): Result<GoogleLoginProvider, IdentityVerificationError> {
  if (!input.clientId || !input.clientSecret) return err(unavailable());
  return Result.fromThrowable((): GoogleLoginProvider => {
    const config = new oidc.Configuration(
      transport.metadata ?? {
        issuer: GOOGLE_ISSUER,
        authorization_endpoint: `${GOOGLE_ISSUER}/o/oauth2/v2/auth`,
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        id_token_signing_alg_values_supported: ["RS256"],
      },
      input.clientId,
      input.clientSecret,
    );
    if (transport.customFetch) config[oidc.customFetch] = transport.customFetch;
    config.timeout = 10;
    oidc.enableNonRepudiationChecks(config);
    return {
      start: (_task, callbackUrl) =>
        ResultAsync.fromThrowable(async () => {
          const state = oidc.randomState();
          const nonce = oidc.randomNonce();
          const codeVerifier = oidc.randomPKCECodeVerifier();
          const authorizationUrl = oidc.buildAuthorizationUrl(config, {
            redirect_uri: callbackUrl,
            scope: "openid email",
            response_type: "code",
            state,
            nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
            code_challenge_method: "S256",
            hd: "heyglide.com",
          }).href;
          return { authorizationUrl, state, nonce, codeVerifier };
        }, unavailable)(),
      complete: (task, callbackUrl, material) =>
        ResultAsync.fromThrowable(async () => {
          const tokens = await oidc.authorizationCodeGrant(config, new URL(callbackUrl), {
            pkceCodeVerifier: material.codeVerifier,
            expectedState: material.state,
            expectedNonce: material.nonce,
            idTokenExpected: true,
          });
          return tokens.claims();
        }, providerFailure)().andThen((claims) =>
          admittedGoogleIdentity(
            claims ?? {},
            input.clientId,
            task.wallNow(),
            transport.metadata?.issuer ?? GOOGLE_ISSUER,
          ),
        ),
    };
  }, unavailable)();
}

export function createGoogleMachineVerifier(
  input: { audience: string; subject: string; now?: () => number },
  transport: {
    fetchKeys?: GoogleKeyFetcher;
    onKeyProviderOutcome?: (outcome: GoogleKeyProviderOutcome) => void;
  } = {},
): MachineTokenVerifier {
  const client = new OAuth2Client({ transporterOptions: { timeout: 5_000, retry: false } });
  const keys = new GoogleMachineKeys(
    transport.fetchKeys ??
      (() =>
        ResultAsync.fromThrowable(() => client.getFederatedSignonCertsAsync(), unavailable)().map(
          (response) => ({
            keys: response.certs as Record<string, string>,
            maxAgeMs: Math.min(
              3_600_000,
              Number(
                /max-age=(\d+)/u.exec(response.res?.headers.get("cache-control") ?? "")?.[1] ?? 300,
              ) * 1000,
            ),
          }),
        )),
    input.now ?? Date.now,
    transport.onKeyProviderOutcome,
  );
  return {
    verify: (token) => {
      if (!input.audience || !input.subject || !token || token.length > 16384)
        return errAsync(invalid());
      const header = Result.fromThrowable(
        (): unknown => JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()),
        invalid,
      )();
      if (
        header.isErr() ||
        typeof header.value !== "object" ||
        header.value === null ||
        !("kid" in header.value) ||
        typeof header.value.kid !== "string" ||
        !("alg" in header.value) ||
        header.value.alg !== "RS256"
      )
        return errAsync(invalid());
      const kid = header.value.kid;
      return keys
        .get(new NoSimulationTask("google machine verification", false), kid)
        .andThen((keySet) => {
          if (!Object.hasOwn(keySet.keys, kid)) return errAsync(invalid());
          return ResultAsync.fromThrowable(
            () =>
              client.verifySignedJwtWithCertsAsync(token, keySet.keys, input.audience, [
                GOOGLE_ISSUER,
                "accounts.google.com",
              ]),
            invalid,
          )();
        })
        .andThen((ticket) => {
          const claims = ticket.getPayload();
          if (
            !claims ||
            (claims.iss !== GOOGLE_ISSUER && claims.iss !== "accounts.google.com") ||
            claims.aud !== input.audience ||
            !claims.exp ||
            claims.exp * 1000 <= (input.now ?? Date.now)() ||
            ("nbf" in claims &&
              (typeof claims.nbf !== "number" || claims.nbf * 1000 > (input.now ?? Date.now)()))
          )
            return err(invalid());
          if (claims.sub !== input.subject)
            return err({ type: "forbidden" as const, message: "Machine identity not admitted" });
          return ok({ kind: "ops" as const, id: claims.sub });
        });
    },
  };
}
