import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import {
  type ApplicationAuth,
  createApplicationAuth,
  type GoogleLoginProvider,
  type SealedCookies,
} from "../domain/application-auth.ts";
import type { User, UserStore } from "../domain/identity.ts";

export type AuthFailure =
  | "exchange-before"
  | "exchange-after"
  | "identity-before"
  | "identity-after";
/** Atomic Google code consumption and identity commit, with explicit response-loss boundaries. */
export class AuthWorld {
  readonly origin = "https://app.example";
  failure: AuthFailure | null;
  user: User | null = null;
  exchanges = 0;
  private readonly consumed = new Set<string>();
  private readonly envelopes = new Map<string, Record<string, unknown>>();
  private ids = 0;
  constructor(failure: AuthFailure | null) {
    this.failure = failure;
  }
  callback(code: string): string {
    return `${this.origin}/auth/callback?code=${code}`;
  }
  sessionCount(): number {
    return [...this.envelopes.values()].filter((value) => value.purpose === "session").length;
  }
  service(task: SimulationTask): ApplicationAuth {
    const cookies: SealedCookies = {
      seal: (value) => {
        const key = `sealed-${this.envelopes.size}`;
        this.envelopes.set(key, value as Record<string, unknown>);
        return okAsync(key);
      },
      unseal: (key) => okAsync(this.envelopes.get(key)),
    };
    const provider: GoogleLoginProvider = {
      start: () =>
        okAsync({
          authorizationUrl: "https://accounts.google.com",
          state: "state",
          nonce: "nonce",
          codeVerifier: "pkce",
        }),
      complete: (exchangeTask, callback) =>
        ResultAsync.fromSafePromise(
          (async () => {
            this.exchanges++;
            await exchangeTask.checkpoint("google:before-exchange");
            if (this.failure === "exchange-before")
              return err({
                type: "identity_unavailable" as const,
                message: "Provider unavailable",
              });
            const code = new URL(callback).searchParams.get("code") ?? "";
            if (this.consumed.has(code))
              return err({ type: "unauthenticated" as const, message: "Code consumed" });
            this.consumed.add(code);
            await exchangeTask.checkpoint("google:after-consume");
            if (this.failure === "exchange-after")
              return err({
                type: "identity_unavailable" as const,
                message: "Exchange response lost",
              });
            return ok({
              issuer: "https://accounts.google.com",
              subject: "stable-subject",
              email: "user@heyglide.com",
            });
          })(),
        ).andThen((result) => result),
    };
    const users: UserStore = {
      getUser: () => okAsync(this.user),
      resolveUser: (storeTask, identity, input) =>
        ResultAsync.fromSafePromise(
          (async () => {
            await storeTask.checkpoint("identity:before-commit");
            if (this.failure === "identity-before")
              return err({
                type: "store_error" as const,
                code: "unavailable" as const,
                retryable: true,
                message: "Store unavailable",
              });
            this.user ??= { id: input.id, email: identity.email };
            await storeTask.checkpoint("identity:after-commit");
            if (this.failure === "identity-after")
              return err({
                type: "store_error" as const,
                code: "unavailable" as const,
                retryable: true,
                message: "Commit response lost",
              });
            return ok(this.user);
          })(),
        ).andThen((result) => result),
    };
    return createApplicationAuth({
      task,
      cookies,
      provider,
      users,
      origins: [this.origin],
      ids: { next: () => ok(`uuid-${this.ids++}`) },
      machine: { verify: () => errAsync({ type: "unauthenticated", message: "No machine token" }) },
    });
  }
}
