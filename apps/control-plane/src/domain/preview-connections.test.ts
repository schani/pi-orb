import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import type { PreviewRoute } from "./preview.ts";
import { PreviewConnections } from "./preview-connections.ts";

const route = (expiresAt: number): PreviewRoute => ({
  target: {
    orbId: "orb-a",
    port: 5173,
    registrationId: "r1",
    incarnation: 0,
    executionId: "boot",
    runtimeInstanceId: "runtime",
  },
  baseUrl: "http://runtime",
  runtimeTokenHash: "hash",
  origin: "https://preview.test",
  expiresAt,
});

it("bounds stream admission without browser presence or agent busy", () => {
  const h = makeHarness();
  const task = new NoSimulationTask("preview-limit", false);
  const connections = new PreviewConnections(h.deps, () =>
    ResultAsync.fromSafePromise(new Promise<void>(() => {})),
  );
  for (let i = 0; i < 16; i++)
    expect(connections.add(task, route(task.wallNow() + 60000), true, () => {}).isOk()).toBe(true);
  expect(connections.add(task, route(task.wallNow() + 60000), true, () => {}).isErr()).toBe(true);
  expect(h.deps.control.hasVisibleBrowser("orb-a")).toBe(false);
  expect(h.deps.control.getLiveness("orb-a")).toBeNull();
});

it("silent WebSocket close earns no durable busy credit", async () => {
  await runDst({ name: "preview-silent-close", iterations: 3 }, async (sim) => {
    const h = makeHarness();
    const result = await sim.runTasks([
      {
        name: "driver",
        f: async (task) => {
          seedRunningOrb(task, h, "orb-a");
          const before = h.store.orbSnapshot("orb-a")!.lastBusyAt;
          const connections = new PreviewConnections(h.deps, () =>
            ResultAsync.fromSafePromise(new Promise<void>(() => {})),
          );
          const connection = connections
            .add(task, route(task.wallNow() + 60000), false, () => {})
            ._unsafeUnwrap();
          await task.sleep(20000, "silent HMR");
          await connection.release(task);
          expect(h.store.orbSnapshot("orb-a")!.lastBusyAt).toBe(before);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});
