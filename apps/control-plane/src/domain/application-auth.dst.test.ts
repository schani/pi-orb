import { expect, it } from "vitest";
import { AuthWorld } from "../testkit/application-auth.ts";
import { runDst } from "../testkit/sim.ts";

it("uncertain code exchange or identity commit issues no authority and never retries", async () => {
  for (const failure of [
    "exchange-before",
    "exchange-after",
    "identity-before",
    "identity-after",
  ] as const) {
    await runDst({ name: `auth-${failure}`, iterations: 10 }, async (sim) => {
      const world = new AuthWorld(failure);
      const result = await sim.runTasks([
        {
          name: "login",
          f: async (task) => {
            const service = world.service(task);
            const first = (await service.startLogin(world.origin, "/draft#text"))._unsafeUnwrap();
            expect(
              (
                await service.completeLogin(
                  world.origin,
                  world.callback("failed"),
                  first.loginCookieValue,
                )
              ).isErr(),
            ).toBe(true);
            expect(world.sessionCount()).toBe(0);
            expect(world.exchanges).toBe(1);
            world.failure = null;
            const fresh = (
              await world.service(task).startLogin(world.origin, "/draft#text")
            )._unsafeUnwrap();
            const completed = (
              await world
                .service(task)
                .completeLogin(world.origin, world.callback("fresh"), fresh.loginCookieValue)
            )._unsafeUnwrap();
            expect(
              (
                await service.authenticateSession(world.origin, completed.sessionCookieValue)
              )._unsafeUnwrap().principal.user.id,
            ).toBe(world.user?.id);
            expect(world.exchanges).toBe(2);
            expect(world.sessionCount()).toBe(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  }
});

it("two logins resolve one UUID; discarded cookie response needs a fresh login", async () => {
  await runDst({ name: "auth-user-resolution-race", iterations: 30 }, async (sim) => {
    const world = new AuthWorld(null);
    const ids: string[] = [];
    const result = await sim.runTasks(
      [0, 1].map((index) => ({
        name: `login-${index}`,
        f: async (task) => {
          const service = world.service(task);
          const login = (await service.startLogin(world.origin, "/"))._unsafeUnwrap();
          const response = (
            await service.completeLogin(
              world.origin,
              world.callback(String(index)),
              login.loginCookieValue,
            )
          )._unsafeUnwrap();
          ids.push(
            (
              await service.authenticateSession(world.origin, response.sessionCookieValue)
            )._unsafeUnwrap().principal.user.id,
          );
          expect(
            (
              await service.completeLogin(
                world.origin,
                world.callback(String(index)),
                login.loginCookieValue,
              )
            ).isErr(),
          ).toBe(true);
          expect((await service.authenticateSession(world.origin, "")).isErr()).toBe(true);
          expect(
            (
              await world
                .service(task)
                .authenticateSession(world.origin, response.sessionCookieValue)
            ).isOk(),
          ).toBe(true);
        },
      })),
    );
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(world.sessionCount()).toBe(2);
  });
});
