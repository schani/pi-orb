import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { RUNTIME_SUBPROTOCOL } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { HarnessAgentPlane } from "../domain/harness-agent-plane.ts";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { registerLiveProxy } from "./live-proxy.ts";

describe.each(["process", "docker", "gce"] as const)("%s SDK live policy", (provider) => {
  it("refuses stopped guest attachment despite an installed agent plane", async () => {
    const h = makeHarness();
    Object.defineProperty(h.deps.hostProvider, "kind", { value: provider });
    h.store.seedOrb(makeOrbRow("orb", "project", "stopped", { harness: "claude" }));
    const app = Fastify();
    let browser: WebSocket | undefined;
    try {
      await registerLiveProxy(app, new NoSimulationTask("SDK live placement", false), {
        ...h.deps,
        agentPlane: new HarnessAgentPlane(
          {
            placement: "central",
            readSession: () => {
              throw new Error("Claude must not attach to central Pi");
            },
          } as never,
          new SdkAgentPlane(h.deps),
          h.store,
        ),
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      browser = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/orbs/orb/live`,
        RUNTIME_SUBPROTOCOL,
      );
      const closed = once(browser, "close");
      await once(browser, "open");
      const [code, reason] = await closed;
      expect(code).toBe(1013);
      expect(reason.toString()).toBe("orb is not running");
      expect(h.deps.control.hasVisibleBrowser("orb")).toBe(false);
    } finally {
      browser?.terminate();
      await app.close();
    }
  });
});
