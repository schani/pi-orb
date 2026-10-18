import { OrbViewSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync } from "neverthrow";
import { Check } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("orb list routes", false);
let h: ReturnType<typeof makeHarness>;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb({ ...makeOrbRow("parent", "project", "running"), runtimeTokenHash: "token" });
  (
    await h.store.spawnOrb(task, {
      callerOrbId: "parent",
      caller: { runtimeTokenHash: "token", hostIncarnation: 0 },
      orb: makeOrbRow("child", "project", "creating"),
      prompt: "work",
      requestHash: "hash",
    })
  )._unsafeUnwrap();
  app = Fastify();
  registerRoutes(app, task, h.deps, {}, TEST_SYSTEM_VIEW);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

it("exposes only caller IDs using one project-list read, without per-orb lookups", async () => {
  const list = vi.spyOn(h.store, "listOrbsByProject");
  const callers = vi.spyOn(h.store, "getSpawnCaller");
  const response = await app.inject({ method: "GET", url: "/api/v1/projects/project/orbs" });
  expect(response.statusCode).toBe(200);
  const items = response.json().items;
  expect(items).toHaveLength(2);
  expect(items.find((orb: { id: string }) => orb.id === "child").spawnedByOrb).toBe("parent");
  expect(items.find((orb: { id: string }) => orb.id === "parent")).not.toHaveProperty(
    "spawnedByOrb",
  );
  for (const orb of items) {
    expect(Check(OrbViewSchema, orb)).toBe(true);
    expect(orb).not.toHaveProperty("spawnedBy");
    expect(orb).not.toHaveProperty("requestHash");
    expect(orb).not.toHaveProperty("callerIncarnation");
  }
  expect(list).toHaveBeenCalledTimes(1);
  expect(callers).not.toHaveBeenCalled();
});

it("exposes the same provenance on direct GET, including a deleted caller", async () => {
  const read = () => app.inject({ method: "GET", url: "/api/v1/orbs/child" });
  expect((await read()).json().spawnedByOrb).toBe("parent");
  const parent = h.store.orbSnapshot("parent");
  expect(parent).not.toBeNull();
  if (parent === null) return;
  const deletion = (
    await h.store.requestOrbDeletion(task, {
      orbId: parent.id,
      expectedStateVersion: parent.stateVersion,
      now: 2000,
      cleanupAfter: 2000,
    })
  )._unsafeUnwrap();
  (
    await h.store.finalizeOrbDeletion(task, {
      orbId: parent.id,
      expectedStateVersion: deletion.stateVersion,
    })
  )._unsafeUnwrap();
  const response = await read();
  expect(response.statusCode).toBe(200);
  expect(response.json().spawnedByOrb).toBe("parent");
  expect(Check(OrbViewSchema, response.json())).toBe(true);
  expect(response.json()).not.toHaveProperty("spawnedBy");
});

it("does not read provenance for a missing orb", async () => {
  const callers = vi.spyOn(h.store, "getSpawnCaller");
  const response = await app.inject({ method: "GET", url: "/api/v1/orbs/missing" });
  expect(response.statusCode).toBe(404);
  expect(callers).not.toHaveBeenCalled();
});

it("keeps a missing project distinct from an empty project", async () => {
  const list = vi.spyOn(h.store, "listOrbsByProject");
  const missing = await app.inject({ method: "GET", url: "/api/v1/projects/missing/orbs" });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe("not_found");
  expect(list).not.toHaveBeenCalled();
  h.store.seedProject(makeProjectRow("empty"));
  const empty = await app.inject({ method: "GET", url: "/api/v1/projects/empty/orbs" });
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({ items: [] });
});

it.each([
  { code: "unavailable" as const, retryable: true, status: 503 },
  { code: "invariant" as const, retryable: false, status: 500 },
])("does not silently drop provenance on $code", async ({ code, retryable, status }) => {
  vi.spyOn(h.store, "listOrbsByProject").mockReturnValue(
    errAsync({
      type: "store_error",
      code,
      retryable,
      message: "list failed",
    }),
  );
  const response = await app.inject({ method: "GET", url: "/api/v1/projects/project/orbs" });
  expect(response.statusCode).toBe(status);
  expect(response.json().error.retryable).toBe(retryable);
  expect(response.json()).not.toHaveProperty("items");
});

it("reports a provenance read outage on direct GET", async () => {
  vi.spyOn(h.store, "getSpawnCaller").mockReturnValue(
    errAsync({
      type: "store_error",
      code: "unavailable",
      retryable: true,
      message: "provenance failed",
    }),
  );
  const response = await app.inject({ method: "GET", url: "/api/v1/orbs/child" });
  expect(response.statusCode).toBe(503);
  expect(response.json().error.retryable).toBe(true);
});
