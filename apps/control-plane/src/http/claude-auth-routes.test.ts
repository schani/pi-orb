import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { ClaudeSubscriptionAuth } from "../domain/claude-auth.ts";
import { FakePointerStore, FakeSecretStore } from "../testkit/broker.ts";
import { registerClaudeAuthRoutes } from "./claude-auth-routes.ts";

describe("owner Claude authentication routes", () => {
  it("uses only the principal, rejects owner selectors and invalid origins", async () => {
    const app = Fastify();
    const pointers = new FakePointerStore();
    let calls = 0;
    const auth = new ClaudeSubscriptionAuth(
      {
        forUser: (id) => {
          expect(id).toBe("owner");
          return pointers;
        },
      },
      new FakeSecretStore(),
      {
        start: () => {
          calls++;
          return okAsync({
            sendCode: () => ok(undefined),
            cancel: () => ok(undefined),
            drain: () => okAsync(undefined),
          });
        },
      },
    );
    app.decorateRequest("principal", undefined);
    app.addHook("onRequest", async (request) => {
      request.principal = { kind: "user", user: { id: "owner", email: null } };
    });
    registerClaudeAuthRoutes(
      app,
      new NoSimulationTask("claude routes", false),
      auth,
      "https://pi.example",
    );
    expect((await app.inject({ method: "GET", url: "/api/v1/claude/auth" })).json()).toEqual({
      status: "disconnected",
    });
    expect(calls).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/claude/auth/connect",
          headers: { origin: "https://bad.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/claude/auth/connect",
          headers: { origin: "https://pi.example" },
          payload: { owner: "other" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/claude/auth/connect",
          headers: { origin: "https://pi.example" },
          payload: {},
        })
      ).json(),
    ).toEqual({ status: "connecting" });
    expect(calls).toBe(1);
    await app.close();
  });
});
