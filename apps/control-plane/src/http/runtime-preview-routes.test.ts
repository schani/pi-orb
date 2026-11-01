import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { registerRuntimePreviewRoutes } from "./runtime-preview-routes.ts";

it("authenticates caller; exposes lists and revokes explicit ports without exposing the runtime port", async () => {
  const h = makeHarness();
  const task = new NoSimulationTask("runtime preview routes", false);
  const id = "00000000-0000-4000-8000-000000000050";
  seedRunningOrb(task, h, id);
  const initial = h.store.orbSnapshot(id);
  assert(initial);
  await h.store.casUpdateFields(task, {
    orbId: id,
    expectedStateVersion: initial.stateVersion,
    runtimeTokenHash: createHash("sha256").update("token").digest("hex"),
    now: task.wallNow(),
  });
  const app = Fastify();
  registerRuntimePreviewRoutes(app, task, {
    store: h.store,
    url: (orbId, port) => ok(`https://p${port}-o${orbId}.preview.test`),
    newId: () => "r1",
    reservedPort: 8080,
  });
  const headers = { authorization: "Bearer token" };
  try {
    expect((await app.inject({ method: "PUT", url: "/runtime/previews/5173" })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: "PUT", url: "/runtime/previews/8080", headers })).statusCode,
    ).toBe(400);
    const exposed = await app.inject({ method: "PUT", url: "/runtime/previews/5173", headers });
    expect(exposed.statusCode).toBe(200);
    expect(exposed.json().preview.url).toBe(`https://p5173-o${id}.preview.test`);
    const list = await app.inject({ method: "GET", url: "/runtime/previews", headers });
    expect(list.json().previews).toEqual([exposed.json().preview]);
    expect(
      (await app.inject({ method: "DELETE", url: "/runtime/previews/5173", headers })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/runtime/previews", headers })).json().previews,
    ).toEqual([]);
    const orb = h.store.orbSnapshot(id);
    assert(orb);
    await h.store.casTransition(task, {
      orbId: id,
      expectedStateVersion: orb.stateVersion,
      toState: "stopping",
      now: task.wallNow(),
    });
    expect(
      (await app.inject({ method: "PUT", url: "/runtime/previews/5173", headers })).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
