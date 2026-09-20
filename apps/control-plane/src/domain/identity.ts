import type { SimulationTask } from "determined";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";

export interface VerifiedUserIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
}

export interface User {
  readonly id: string;
  readonly email: string | null;
}

export type RequestPrincipal =
  | { readonly kind: "user"; readonly user: User }
  | { readonly kind: "ops"; readonly id: string };

export type IdentityVerificationError =
  | { readonly type: "forbidden"; readonly message: string }
  | { readonly type: "unauthenticated"; readonly message: string }
  | { readonly type: "identity_unavailable"; readonly message: string };

export interface UserIdentityVerifier<Request> {
  verify(request: Request): ResultAsync<VerifiedUserIdentity, IdentityVerificationError>;
}

export interface UserStore {
  getUser(task: SimulationTask, userId: string): ResultAsync<User | null, StoreError>;
  resolveUser(
    task: SimulationTask,
    identity: VerifiedUserIdentity,
    input: { readonly id: string; readonly now: number },
  ): ResultAsync<User, StoreError>;
}

export interface UserIdSource {
  next(): Result<string, IdentityVerificationError>;
}

export type PrincipalResolutionError = IdentityVerificationError | StoreError;

export function resolveUserPrincipal<Request>(
  task: SimulationTask,
  verifier: UserIdentityVerifier<Request>,
  users: UserStore,
  ids: UserIdSource,
  request: Request,
): ResultAsync<RequestPrincipal, PrincipalResolutionError> {
  return verifier
    .verify(request)
    .andThen((identity) => {
      const id = ids.next();
      return id.isErr()
        ? errAsync(id.error)
        : users.resolveUser(task, identity, { id: id.value, now: task.wallNow() });
    })
    .map((user) => ({ kind: "user" as const, user }));
}

export function fixedUserIdentityVerifier<Request>(
  identity: VerifiedUserIdentity,
): UserIdentityVerifier<Request> {
  return { verify: () => okAsync(identity) };
}
