import type { OrbView } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  TEST_SYSTEM_VIEW,
  TEST_USER_ID,
} from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

describe.each(["process", "docker", "gce"] as const)("%s browser placement", (provider) => {
  it.each(["host", "central"] as const)(
    "advertises %s placement independently of provider",
    async (placement) => {
      const h = makeHarness();
      Object.defineProperty(h.deps.hostProvider, "kind", { value: provider });
      const plane = new SdkAgentPlane(h.deps);
      if (placement === "central") Object.defineProperty(plane, "placement", { value: placement });
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(makeOrbRow("busy", "project", "running"));
      h.store.seedOrb(makeOrbRow("stopped", "project", "stopped"));
      h.store.seedOrb(makeOrbRow("claude", "project", "running", { harness: "claude" }));
      h.deps.control.recordPullSuccess("claude", 1, "busy", "claude-runtime");
      h.deps.control.recordPullSuccess("busy", 1, "busy", "sdk-runtime");
      h.deps.control.noteAgentWork("busy", placement === "central");
      const app = Fastify();
      app.decorateRequest("principal", undefined);
      app.addHook("onRequest", async (request) => {
        request.principal = { kind: "user", user: { id: TEST_USER_ID, email: null } };
      });
      try {
        registerRoutes(
          app,
          new NoSimulationTask("browser placement", false),
          { ...h.deps, agentPlane: plane },
          {},
          TEST_SYSTEM_VIEW,
        );
        const busy = await app.inject({ method: "GET", url: "/api/v1/orbs/busy" });
        expect(busy.statusCode).toBe(200);
        const view = busy.json<OrbView>();
        expect(view.centralAgent === true).toBe(placement === "central");
        expect(view.activity).toBe("busy");
        const stopped = await app.inject({ method: "GET", url: "/api/v1/orbs/stopped" });
        expect(stopped.statusCode).toBe(200);
        expect(stopped.json<OrbView>().centralAgent === true).toBe(placement === "central");
        const claude = await app.inject({ method: "GET", url: "/api/v1/orbs/claude" });
        expect(claude.json<OrbView>().centralAgent).toBeUndefined();
        expect(claude.json<OrbView>().activity).toBe("busy");
        const list = await app.inject({ method: "GET", url: "/api/v1/projects/project/orbs" });
        expect(list.statusCode).toBe(200);
        for (const orb of list.json<{ items: OrbView[] }>().items)
          expect(orb.centralAgent === true).toBe(placement === "central" && orb.harness === "pi");
      } finally {
        await app.close();
      }
    },
  );
});
