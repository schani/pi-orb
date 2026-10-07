import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { PreviewActivity } from "./preview-activity.ts";

it("HTTP ownership includes silent SSE; WS ownership expires without application messages", () => {
  let now = 0;
  const activity = new PreviewActivity(() => now);
  const http = activity.acquire("http");
  now = 60_000;
  expect(activity.blocksIdle()).toBe(true);
  http.release();
  http.release();
  expect(activity.blocksIdle()).toBe(false);
  const ws = activity.acquire("websocket");
  expect(activity.blocksIdle()).toBe(true);
  now += 15_001;
  expect(activity.blocksIdle()).toBe(false);
  ws.touch();
  expect(activity.blocksIdle()).toBe(true);
  ws.release();
});

it("admission and persisted idle fence have a single synchronous owner", async () => {
  await runDst({ name: "preview-idle-admission", iterations: 30 }, async (sim) => {
    const activity = new PreviewActivity(() => 0);
    let fenced = false;
    let dialed = false;
    const result = await sim.runTasks([
      {
        name: "admit",
        f: async (task) => {
          await task.checkpoint("preview.before-admission");
          if (fenced) return;
          const lease = activity.acquire("http");
          dialed = true;
          await task.checkpoint("preview.owned-before-dial");
          expect(fenced).toBe(false);
          lease.release();
        },
      },
      {
        name: "idle",
        f: async (task) => {
          await task.checkpoint("preview.before-idle-fence");
          if (!activity.blocksIdle()) fenced = true;
        },
      },
    ]);
    expect(result.isOk()).toBe(true);
    expect(dialed || fenced).toBe(true);
  });
});
