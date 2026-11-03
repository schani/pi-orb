import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { createSealedAuthCookies } from "../adapters/sealed-auth-cookies.ts";
import { createPreviewAuth } from "./preview-auth.ts";

it("binds encrypted challenges, tickets and sessions to purpose, origin, proof and fixed expiry", async () => {
  let now = 1000;
  const cookies = createSealedAuthCookies(
    "a sufficiently long shared cookie sealing key",
  )._unsafeUnwrap();
  const auth = createPreviewAuth({ cookies, now: () => now, challenge: () => ok("random-proof") });
  const origin = "https://p5173-o12345678-1234-4234-8234-123456789abc.preview.test";
  const identity = {
    principal: { kind: "user" as const, user: { id: "coworker", email: null } },
    expiresAt: 120_000,
  };
  const challenge = (await auth.start(origin, "/deep?q=1"))._unsafeUnwrap();
  const ticket = (await auth.issue(origin, challenge.proof, identity))._unsafeUnwrap();
  const session = (await auth.complete(origin, challenge.cookie, ticket))._unsafeUnwrap();
  expect(session.returnTo).toBe("/deep?q=1");
  expect((await auth.authenticate(origin, session.cookie))._unsafeUnwrap()).toEqual(identity);
  // Stateless replay is accepted while both ticket and copied challenge remain valid.
  expect((await auth.complete(origin, challenge.cookie, ticket)).isOk()).toBe(true);
  for (const [o, c, t] of [
    [origin + ".evil", challenge.cookie, ticket],
    [origin, ticket, ticket],
    [origin, challenge.cookie, challenge.cookie],
    [origin, challenge.cookie, ticket + "tampered"],
  ])
    expect((await auth.complete(o!, c!, t!)).isErr()).toBe(true);
  expect((await auth.authenticate(origin, ticket)).isErr()).toBe(true);
  expect((await auth.authenticate(origin + ".evil", session.cookie)).isErr()).toBe(true);
  const wrong = (await auth.issue(origin, "wrong", identity))._unsafeUnwrap();
  expect((await auth.complete(origin, challenge.cookie, wrong)).isErr()).toBe(true);
  now = 61_000;
  expect((await auth.complete(origin, challenge.cookie, ticket)).isErr()).toBe(true);
  const longIdentity = { ...identity, expiresAt: 1_000_000 };
  now = 601_000;
  const freshTicket = (await auth.issue(origin, challenge.proof, longIdentity))._unsafeUnwrap();
  expect((await auth.complete(origin, challenge.cookie, freshTicket)).isErr()).toBe(true);
  now = 61_000;
  expect((await auth.authenticate(origin, session.cookie)).isOk()).toBe(true);
  now = identity.expiresAt;
  expect((await auth.authenticate(origin, session.cookie)).isErr()).toBe(true);
  expect((await auth.issue(origin, challenge.proof, identity)).isErr()).toBe(true);
});
it("rejects unsafe navigation paths", async () => {
  const auth = createPreviewAuth({
    cookies: createSealedAuthCookies(
      "a sufficiently long shared cookie sealing key",
    )._unsafeUnwrap(),
    now: () => 0,
    challenge: () => ok("proof"),
  });
  for (const path of ["//evil.test", "/\\evil.test", "/\nheader", "/__pi_orb/auth/callback"])
    expect((await auth.start("https://preview.test", path)).isErr()).toBe(true);
});
