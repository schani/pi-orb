import { NoSimulationTask } from "determined";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { resolveUserPrincipal } from "./identity.ts";

const task = new NoSimulationTask("identity", false);

describe("principal resolution", () => {
  it("passes verified identity, generated id, and clock to the user store", async () => {
    const identity = { issuer: "issuer", subject: "subject", email: "a@example.test" };
    const seen: unknown[] = [];
    const result = await resolveUserPrincipal(
      task,
      { verify: () => okAsync(identity) },
      {
        getUser: () => okAsync(null),
        resolveUser: (_task, actual, input) => {
          seen.push(actual, input);
          return okAsync({ id: input.id, email: actual.email });
        },
      },
      { next: () => ok("00000000-0000-4000-8000-000000000001") },
      {},
    );
    expect(result._unsafeUnwrap()).toEqual({
      kind: "user",
      user: { id: "00000000-0000-4000-8000-000000000001", email: identity.email },
    });
    expect(seen[0]).toEqual(identity);
  });

  it("does not touch the store when verification fails", async () => {
    let touched = false;
    const result = await resolveUserPrincipal(
      task,
      { verify: () => errAsync({ type: "unauthenticated" as const, message: "invalid identity" }) },
      {
        getUser: () => okAsync(null),
        resolveUser: () => {
          touched = true;
          return okAsync({ id: "x", email: null });
        },
      },
      { next: () => ok("x") },
      {},
    );
    expect(result.isErr()).toBe(true);
    expect(touched).toBe(false);
  });

  it("returns ID adapter failures without touching the store", async () => {
    let touched = false;
    const result = await resolveUserPrincipal(
      task,
      { verify: () => okAsync({ issuer: "i", subject: "s", email: null }) },
      {
        getUser: () => okAsync(null),
        resolveUser: () => {
          touched = true;
          return okAsync({ id: "x", email: null });
        },
      },
      {
        next: () =>
          err({ type: "identity_unavailable" as const, message: "user ID generation unavailable" }),
      },
      {},
    );
    expect(result.isErr() && result.error.type).toBe("identity_unavailable");
    expect(touched).toBe(false);
  });
});
