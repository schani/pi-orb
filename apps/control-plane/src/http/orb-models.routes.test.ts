import { OrbViewSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerAuthenticatedBrowserRoutes } from "./browser-identity.ts";
import { registerRoutes } from "./routes.ts";

it("projects and accepts only the harness's offline choices, without waking the orb", async () => {
  const task = new NoSimulationTask("offline model route", false);
  const { deps, store } = makeHarness();
  const project = makeProjectRow("project");
  const id = "00000000-0000-4000-8000-0000000000c1";
  const orb = makeOrbRow(id, project.id, "stopped", { stopReason: "manual", stateVersion: 5 });
  store.seedProject(project);
  store.seedOrb(orb);
  const start = vi.spyOn(deps.hostProvider, "start");
  const app = Fastify();
  registerAuthenticatedBrowserRoutes(
    app,
    () => okAsync({ kind: "user", user: { id: "coworker", email: null } }),
    (scope) => registerRoutes(scope, task, deps, TEST_SYSTEM_VIEW),
  );

  const url = `/api/v1/orbs/${id}`;
  const get = () => app.inject({ method: "GET", url });
  const put = (model: { provider: string; id: string }) =>
    app.inject({ method: "PUT", url: `${url}/pending-model`, payload: { model } });
  const model = { provider: "openai-codex", id: "gpt-6.2-sol" };

  try {
    const before = (await get()).json();
    expect(before.queueableModels).toContainEqual({ ...model, name: "Sol" });
    expect((await put({ provider: "claude", id: "opus" })).statusCode).toBe(400);
    expect((await put({ ...model, id: "not-allowlisted" })).statusCode).toBe(400);
    expect((await get()).json().pendingModel).toBeNull();

    const accepted = await put(model);
    expect(accepted.statusCode).toBe(200);
    const view = accepted.json();
    expect(Check(OrbViewSchema, view)).toBe(true);
    expect(view).toMatchObject({
      state: "stopped",
      stateVersion: 5,
      pendingModel: { changeId: expect.any(String), model },
    });
    expect((await get()).json().pendingModel).toEqual(view.pendingModel);

    store.seedOrb({ ...orb, state: "running" });
    expect((await get()).json()).not.toHaveProperty("queueableModels");
    expect((await put(model)).statusCode).toBe(409);
    expect(start).not.toHaveBeenCalled();
  } finally {
    await app.close();
    start.mockRestore();
  }
});
