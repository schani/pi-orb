import type { SimulationTask } from "determined";
import type { FastifyRequest } from "fastify";
import { err, ok, okAsync, type Result } from "neverthrow";
import { type IapRequest, readIapAudience } from "./adapters/iap-identity.ts";
import {
  fixedUserIdentityVerifier,
  type RequestPrincipal,
  resolveUserPrincipal,
  type UserIdentityVerifier,
  type UserIdSource,
  type UserStore,
} from "./domain/identity.ts";
import type { ControlPlaneRole } from "./hosting-config.ts";
import type { RequestPrincipalResolver } from "./http/browser-identity.ts";

export type RequestIdentityConfig =
  | { readonly kind: "browser"; readonly audience: string }
  | { readonly kind: "local" }
  | { readonly kind: "ops"; readonly id: string }
  | { readonly kind: "none" };

export function readRequestIdentityConfig(
  role: ControlPlaneRole,
  environment: Readonly<Record<string, string | undefined>>,
): Result<RequestIdentityConfig, string> {
  if (role === "browser") {
    const audience = readIapAudience(environment["PI_ORB_IAP_AUDIENCE"] ?? "");
    return audience.isErr()
      ? err(`PI_ORB_IAP_AUDIENCE ${audience.error}`)
      : ok({ kind: "browser", audience: audience.value });
  }
  if (role === "all") return ok({ kind: "local" });
  if (role === "ops") {
    const id = environment["PI_ORB_OPS_PRINCIPAL"] ?? "";
    return id === ""
      ? err("PI_ORB_OPS_PRINCIPAL is required for the ops role")
      : ok({ kind: "ops", id });
  }
  return ok({ kind: "none" });
}

export function createRequestPrincipalResolver(
  task: SimulationTask,
  config: Exclude<RequestIdentityConfig, { readonly kind: "none" }>,
  users: UserStore,
  ids: UserIdSource,
  browserVerifier?: UserIdentityVerifier<IapRequest>,
): Result<RequestPrincipalResolver, string> {
  if (config.kind === "ops") {
    return ok(() => okAsync<RequestPrincipal>({ kind: "ops", id: config.id }));
  }
  const verifier =
    config.kind === "local"
      ? fixedUserIdentityVerifier<IapRequest>({
          issuer: "pi-orb:local",
          subject: "developer",
          email: null,
        })
      : browserVerifier;
  if (verifier === undefined) return err("browser identity verifier is required");
  return ok((request: FastifyRequest) =>
    resolveUserPrincipal(task, verifier, users, ids, {
      headers: {
        "x-goog-iap-jwt-assertion": request.headers["x-goog-iap-jwt-assertion"],
      },
    }),
  );
}
