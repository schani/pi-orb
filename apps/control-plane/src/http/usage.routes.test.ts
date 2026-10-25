import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { ModelUsageReader } from "../domain/usage-read.ts";
import { makeHarness, TEST_SYSTEM_VIEW, TEST_USER_ID } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("reads selected-user usage, refuses user overrides, validates input and exposes store failures", async () => {
  const h = makeHarness();
  const read = vi.fn<ModelUsageReader["read"]>(() => okAsync({ buckets: [], orbs: [] }));
  const app = Fastify();
  app.decorateRequest("principal", undefined);
  app.addHook("onRequest", async (request) => {
    request.principal = { kind: "user", user: { id: TEST_USER_ID, email: null } };
  });
  registerRoutes(
    app,
    new NoSimulationTask("usage routes", false),
    { ...h.deps, modelUsage: { ...h.deps.modelUsage, read } },
    {},
    TEST_SYSTEM_VIEW,
  );
  const url = "/api/v1/usage?boundaries=" + encodeURIComponent("[0,900000]");
  try {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().summary.calls).toBe(0);
    expect(read.mock.calls[0]?.[1]).toBe(TEST_USER_ID);
    expect(
      (await app.inject({ method: "GET", url, headers: { "x-pi-orb-user-id": "other" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/usage?boundaries=broken" })).statusCode,
    ).toBe(400);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockImplementation(() =>
      errAsync({
        type: "store_error",
        code: "unavailable",
        message: "database offline",
        retryable: true,
      }),
    );
    const failed = await app.inject({ method: "GET", url });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toEqual({
      code: "unavailable",
      message: "database offline",
      retryable: true,
    });
  } finally {
    await app.close();
  }
});
