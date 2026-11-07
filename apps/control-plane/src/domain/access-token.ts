import type { SimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { IdentityVerificationError } from "./identity.ts";
import type { ControlPlaneStore } from "./ports.ts";

/**
 * An orb's own `pi-orb id-token` for this audience admits previews and hosted
 * files of orbs with the same project owner (`docs/http-exposure.md`).
 */
export const ACCESS_TOKEN_AUDIENCE = "urn:pi-orb:access";
/** Scripts send the header; browsers the host-only cookie, which also reaches WebSocket upgrades. */
export const ACCESS_TOKEN_HEADER = "x-pi-orb-token";
export const ACCESS_TOKEN_COOKIE = "__Host-pi-orb-token";

/** Signature check against this issuer's published keys; returns the unjudged claims. */
export interface IdTokenVerifier {
  verify(
    task: SimulationTask,
    jwt: string,
  ): ResultAsync<Readonly<Record<string, unknown>>, IdentityVerificationError>;
}
export interface AccessTokenDeps {
  readonly verifier: IdTokenVerifier;
  readonly store: Pick<ControlPlaneStore, "getOrb" | "getProject">;
  readonly issuerUrl: string;
}
export interface AccessTokenIdentity {
  readonly ownerUserId: string;
  readonly orbId: string;
  readonly expiresAt: number;
}
const denied = (): IdentityVerificationError => ({
  type: "unauthenticated",
  message: "Invalid or expired access token",
});

function ownerOf(task: SimulationTask, deps: AccessTokenDeps, orbId: string) {
  return deps.store
    .getOrb(task, orbId)
    .andThen((orb) => (orb ? deps.store.getProject(task, orb.projectId) : okAsync(null)))
    .map((project) => project?.ownerUserId ?? null)
    .mapErr(
      (): IdentityVerificationError => ({
        type: "identity_unavailable",
        message: "Access token verification unavailable",
      }),
    );
}

/** A missing target passes: the resource route then reports that it doesn't exist. */
export function verifyAccessToken(
  task: SimulationTask,
  deps: AccessTokenDeps,
  token: string,
  targetOrbId: string,
): ResultAsync<AccessTokenIdentity, IdentityVerificationError> {
  return deps.verifier.verify(task, token).andThen((claims) => {
    const { orb_id: orbId, exp } = claims;
    if (
      claims.iss !== deps.issuerUrl ||
      claims.aud !== ACCESS_TOKEN_AUDIENCE ||
      claims.token_use !== "exchanged" ||
      typeof orbId !== "string" ||
      typeof exp !== "number" ||
      exp * 1000 <= task.wallNow()
    )
      return errAsync(denied());
    return ownerOf(task, deps, orbId).andThen((ownerUserId) =>
      ownerUserId === null
        ? errAsync(denied())
        : ownerOf(task, deps, targetOrbId).andThen((targetOwner) =>
            targetOwner === null || targetOwner === ownerUserId
              ? okAsync({ ownerUserId, orbId, expiresAt: exp * 1000 })
              : errAsync<AccessTokenIdentity, IdentityVerificationError>({
                  type: "forbidden",
                  message: "Access token owner doesn't own this orb",
                }),
          ),
    );
  });
}
