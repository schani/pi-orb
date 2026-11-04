import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { ACCESS_TOKEN_AUDIENCE, verifyAccessToken } from "./access-token.ts";

const task = new NoSimulationTask("access token", false);
const claims = {
  iss: "https://issuer.test",
  aud: ACCESS_TOKEN_AUDIENCE,
  orb_id: "caller",
  token_use: "exchanged",
  exp: Math.floor(task.wallNow() / 1000) + 600,
};
function deps() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("mine"), ownerUserId: "owner" });
  h.store.seedProject({ ...makeProjectRow("theirs"), ownerUserId: "coworker" });
  h.store.seedOrb(makeOrbRow("caller", "mine", "running"));
  h.store.seedOrb(makeOrbRow("sibling", "mine", "stopped"));
  h.store.seedOrb(makeOrbRow("foreign", "theirs", "running"));
  // The fake verifier treats the token as its JSON claims; signatures are the adapter's.
  const verifier = { verify: (_task: unknown, jwt: string) => okAsync(JSON.parse(jwt)) };
  return { verifier, store: h.store, issuerUrl: claims.iss };
}
const verify = (value: object, target: string) =>
  verifyAccessToken(task, deps(), JSON.stringify(value), target);

it("admits only orbs with the token orb's owner", async () => {
  const identity = { ownerUserId: "owner", orbId: "caller", expiresAt: claims.exp * 1000 };
  expect((await verify(claims, "caller"))._unsafeUnwrap()).toEqual(identity);
  expect((await verify(claims, "sibling"))._unsafeUnwrap()).toEqual(identity);
  expect((await verify(claims, "missing")).isOk()).toBe(true);
  expect((await verify(claims, "foreign"))._unsafeUnwrapErr().type).toBe("forbidden");
});

it("rejects tokens for another issuer, audience, use, orb or time", async () => {
  for (const changed of [
    { iss: "https://other.test" },
    { aud: "https://service.example" },
    { aud: [ACCESS_TOKEN_AUDIENCE] },
    { token_use: "other" },
    { orb_id: "deleted" },
    { exp: Math.floor(task.wallNow() / 1000) - 1 },
  ])
    expect((await verify({ ...claims, ...changed }, "caller"))._unsafeUnwrapErr().type).toBe(
      "unauthenticated",
    );
});
