import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  createApplicationAuth,
  type GoogleLoginProvider,
  SESSION_LIFETIME_MS,
  type SealedCookies,
} from "./application-auth.ts";

const origin = "https://app.example";
describe("stateless application auth", () => {
  it("uses a seven-day session lifetime", () => {
    expect(SESSION_LIFETIME_MS).toBe(604_800_000);
  });

  it("single-use exchange across instances, durable UUID, fixed expiry and origin isolation", async () => {
    const options = {
      name: "application-auth-callback-race",
      iterations: 20,
      maxVirtualDurationMs: 604_800_000,
    };
    await runDst(options, async (sim) => {
      const values = new Map<string, unknown>();
      const cookies: SealedCookies = {
        seal: (value) => {
          const key = String(values.size);
          values.set(key, value);
          return okAsync(key);
        },
        unseal: (key) => okAsync(values.get(key)),
      };
      let consumed = false;
      let issued = 0;
      const provider: GoogleLoginProvider = {
        start: () =>
          okAsync({
            authorizationUrl: "https://accounts.google.com",
            state: "state",
            nonce: "nonce",
            codeVerifier: "pkce",
          }),
        complete: (task) =>
          ResultAsync.fromSafePromise(
            (async () => {
              await task.checkpoint("google:before-consume");
              if (consumed) return false;
              consumed = true;
              await task.checkpoint("google:after-consume");
              return true;
            })(),
          ).andThen((accepted) =>
            accepted
              ? okAsync({
                  issuer: "https://accounts.google.com",
                  subject: "sub",
                  email: "a@heyglide.com",
                })
              : errAsync({ type: "unauthenticated" as const, message: "Code consumed" }),
          ),
      };
      const result = await sim.runTasks(
        [0, 1].map((instance) => ({
          name: `callback-${instance}`,
          f: async (task) => {
            const auth = createApplicationAuth({
              task,
              cookies,
              provider,
              origins: [origin],
              ids: { next: () => ok("new-id") },
              users: {
                getUser: () => okAsync(null),
                resolveUser: () => okAsync({ id: "existing-uuid", email: "a@heyglide.com" }),
              },
              machine: {
                verify: () => errAsync({ type: "unauthenticated" as const, message: "No token" }),
              },
            });
            const started = await auth.startLogin(origin, "/orb/one#draft");
            expect(started.isOk()).toBe(true);
            if (started.isErr()) return;
            const completed = await auth.completeLogin(
              origin,
              `${origin}/auth/callback?code=one`,
              started.value.loginCookieValue,
            );
            if (completed.isErr()) return;
            issued++;
            expect(completed.value.returnTo).toBe("/orb/one#draft");
            const session = await auth.authenticateSession(
              origin,
              completed.value.sessionCookieValue,
            );
            expect(session.isOk() && session.value.principal.user.id).toBe("existing-uuid");
            expect(session.isOk() && session.value.expiresAt).toBe(task.wallNow() + 604_800_000);
            expect(
              (
                await auth.authenticateSession(
                  "https://files.example",
                  completed.value.sessionCookieValue,
                )
              ).isErr(),
            ).toBe(true);
            expect(
              (await auth.authenticateSession(origin, started.value.loginCookieValue)).isErr(),
            ).toBe(true);
            expect(
              (await auth.authenticateSession(origin, completed.value.sessionCookieValue)).isOk(),
            ).toBe(true);
            expect((await auth.startLogin(origin, "//evil.example")).isErr()).toBe(true);
            expect((await auth.startLogin("https://evil.example", "/")).isErr()).toBe(true);
            const expiresAt = session.isOk() ? session.value.expiresAt : 0;
            await task.sleep(12 * 60 * 60_000, "old twelve-hour cutoff");
            const afterTwelveHours = await auth.authenticateSession(
              origin,
              completed.value.sessionCookieValue,
            );
            expect(afterTwelveHours.isOk() && afterTwelveHours.value.expiresAt).toBe(expiresAt);
            await task.sleep(expiresAt - task.wallNow() - 1, "just before session expiry");
            expect(
              (await auth.authenticateSession(origin, completed.value.sessionCookieValue)).isOk(),
            ).toBe(true);
            await task.sleep(1, "exact session expiry");
            expect(
              (await auth.authenticateSession(origin, completed.value.sessionCookieValue)).isErr(),
            ).toBe(true);
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(issued).toBe(1);
    });
  });
});
