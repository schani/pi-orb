import { expect, it } from "vitest";
import { StreamMonitor } from "./stream-monitor.ts";
import { StreamTelemetry } from "./stream-telemetry.ts";

it("scheduled polls emit edges only and shutdown fences captured callbacks", () => {
  let now = 0;
  let callback = () => {};
  let cancels = 0;
  const telemetry = new StreamTelemetry(() => now);
  telemetry.start({ requestId: "id", operationId: "op", sessionId: "root", attempt: 1 });
  const edges: unknown[] = [];
  const monitor = new StreamMonitor(
    telemetry,
    (edge) => edges.push(edge),
    (tick) => {
      callback = tick;
      return () => {
        cancels++;
      };
    },
  );
  monitor.start();
  monitor.start();
  callback();
  expect(edges).toEqual([]);
  now = 60_000;
  callback();
  callback();
  expect(edges).toHaveLength(1);
  monitor.stop();
  monitor.stop();
  telemetry.start({ requestId: "later", operationId: "op", sessionId: "root", attempt: 2 });
  now += 60_000;
  callback();
  expect(edges).toHaveLength(1);
  expect(cancels).toBe(1);
});
