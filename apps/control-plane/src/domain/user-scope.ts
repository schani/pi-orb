import type { SimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import type { RequestPrincipal, User, UserStore } from "./identity.ts";

export type UserScopeError =
  | { readonly type: "invalid_user_selection"; readonly message: string }
  | { readonly type: "user_not_found"; readonly message: string }
  | StoreError;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class UserScope {
  private readonly users: UserStore;
  constructor(users: UserStore) {
    this.users = users;
  }

  resolve(
    task: SimulationTask,
    principal: RequestPrincipal,
    selectedUserId: unknown,
  ): ResultAsync<User, UserScopeError> {
    if (principal.kind === "user") {
      return selectedUserId === undefined
        ? okAsync(principal.user)
        : errAsync({
            type: "invalid_user_selection" as const,
            message: "user principals cannot select another user",
          });
    }
    if (typeof selectedUserId !== "string" || !UUID.test(selectedUserId)) {
      return errAsync({
        type: "invalid_user_selection" as const,
        message: "X-Pi-Orb-User-Id must be a UUID",
      });
    }
    return this.users
      .getUser(task, selectedUserId)
      .andThen((user) =>
        user === null
          ? errAsync({ type: "user_not_found" as const, message: "selected user does not exist" })
          : okAsync(user),
      );
  }
}
