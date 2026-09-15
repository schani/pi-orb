import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("browser routes read/save one document without project scope, reject invalid bodies and expose failures", async () => {
  const h = makeHarness();
  const app = Fastify();
  registerRoutes(app, new NoSimulationTask("personal routes", false), h.deps, {}, TEST_SYSTEM_VIEW);
  try {
    const initial = await app.inject({ method: "GET", url: "/api/v1/personal-instructions" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ content: "", revision: 0 });
    expect(initial.headers["cache-control"]).toBe("no-store");
    for (const content of ["# Across projects\r\n", ""]) {
      const saved = await app.inject({
        method: "PUT",
        url: "/api/v1/personal-instructions",
        payload: { content },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().content).toBe(content);
      expect(saved.headers["cache-control"]).toBe("no-store");
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/personal-instructions",
          payload: { content: "\0" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/personal-instructions",
          payload: { content: "no", projectId: "a" },
        })
      ).statusCode,
    ).toBe(400);
    h.deps.personalInstructions.read = () =>
      errAsync({
        type: "personal_instructions_error",
        code: "unavailable",
        message: "Personal instructions unavailable",
      });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/personal-instructions" })).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
