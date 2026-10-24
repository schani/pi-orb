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
    const otherPath = "/api/v1/projects/b/instructions";
    const otherInitial = await app.inject({ method: "GET", url: otherPath });
    expect(otherInitial.statusCode).toBe(200);
    expect(otherInitial.json()).toEqual({ content: "", revision: 0 });
    const otherSaved = await app.inject({
      method: "PUT",
      url: otherPath,
      payload: { content: "# Project B\n" },
    });
    expect(otherSaved.statusCode).toBe(200);
    expect(otherSaved.json()).toEqual({ content: "# Project B\n", revision: 1 });
    let revision = 0;
    for (const content of ["# Extra\r\n", ""]) {
      const saved = await app.inject({ method: "PUT", url: path, payload: { content } });
      expect(saved.statusCode).toBe(200);
      revision += 1;
      expect(saved.json()).toEqual({ content, revision });
      expect(saved.headers["cache-control"]).toBe("no-store");
      const readback = await app.inject({ method: "GET", url: path });
      expect(readback.statusCode).toBe(200);
      expect(readback.json()).toEqual(saved.json());
      expect(readback.headers["cache-control"]).toBe("no-store");
      const other = await app.inject({ method: "GET", url: otherPath });
      expect(other.statusCode).toBe(200);
      expect(other.json()).toEqual(otherSaved.json());
    }
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
