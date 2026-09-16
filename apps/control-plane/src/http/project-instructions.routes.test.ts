import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("project instruction routes isolate scope, preserve missing resources and report typed failures", async () => {
  const h = makeHarness();
  for (const id of ["a", "b"]) h.store.seedProject(makeProjectRow(id));
  const app = Fastify();
  registerRoutes(
    app,
    new NoSimulationTask("project instructions routes", false),
    h.deps,
    {},
    TEST_SYSTEM_VIEW,
  );
  try {
    const path = "/api/v1/projects/a/instructions";
    const read = await app.inject({ method: "GET", url: path });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ content: "", revision: 0 });
    expect(read.headers["cache-control"]).toBe("no-store");
    for (const content of ["# Extra\r\n", ""]) {
      const saved = await app.inject({ method: "PUT", url: path, payload: { content } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().content).toBe(content);
      expect(saved.headers["cache-control"]).toBe("no-store");
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/projects/b/instructions" })).json(),
    ).toEqual({ content: "", revision: 0 });
    expect(
      (await app.inject({ method: "PUT", url: path, payload: { content: "bad\0" } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: path, payload: { content: "bad", projectId: "b" } }))
        .statusCode,
    ).toBe(400);
    for (const method of ["GET", "PUT"] as const) {
      const missing = await app.inject({
        method,
        url: "/api/v1/projects/missing/instructions",
        ...(method === "PUT" ? { payload: { content: "no" } } : {}),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.message).toBe("Project doesn't exist");
    }
    h.store.seedProject({ ...makeProjectRow("a"), state: "deleting" });
    expect(
      (await app.inject({ method: "PUT", url: path, payload: { content: "no" } })).statusCode,
    ).toBe(409);
    h.deps.projectInstructions.read = () =>
      errAsync({
        type: "project_instructions_error",
        code: "unavailable",
        message: "Project instructions unavailable",
      });
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(503);
    h.deps.projectInstructions.read = () =>
      errAsync({
        type: "project_instructions_error",
        code: "internal",
        message: "Project instructions storage is inconsistent",
      });
    const failed = await app.inject({ method: "GET", url: path });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.retryable).toBe(false);
  } finally {
    await app.close();
  }
});
