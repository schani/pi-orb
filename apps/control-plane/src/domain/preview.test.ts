import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import {
  admitPreview,
  type PreviewRoute,
  previewCloseError,
  recordPreviewTransport,
} from "./preview.ts";

it("distinguishes normal WebSocket close from forwarding failure", () => {
  expect(previewCloseError({ code: 1000, reason: "done" })).toBeNull();
  expect(previewCloseError({ code: 1001, reason: "leaving" })).toBeNull();
  expect(previewCloseError({ code: 3001, reason: "application" })).toBeNull();
  expect(previewCloseError({ code: 1009, reason: "private detail" })?.code).toBe(
    "capacity_exceeded",
  );
  expect(previewCloseError({ code: 1011, reason: "private detail" })?.code).toBe("upstream_failed");
});

it("records transport blocker and recovery edges without healthy request noise", () => {
  const h = makeHarness();
  const logs: unknown[] = [];
  const task = new NoSimulationTask("preview-transport-telemetry", false);
  task.log = (...values) => {
    logs.push(...values);
  };
  const route: PreviewRoute = {
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 0,
      executionId: "boot",
      runtimeInstanceId: "rt",
    },
    baseUrl: "http://private",
    runtimeTokenHash: "secret",
    origin: "https://preview.test",
    expiresAt: task.wallNow() + 60000,
  };
  recordPreviewTransport(task, h.deps, route, "connect", null);
  const error = {
    type: "preview_error",
    code: "target_refused",
    message: "Private details",
  } as const;
  recordPreviewTransport(task, h.deps, route, "connect", error);
  recordPreviewTransport(task, h.deps, route, "connect", error);
  recordPreviewTransport(task, h.deps, route, "connect", null);
  recordPreviewTransport(task, h.deps, route, "connect", null);
  expect(logs).toHaveLength(2);
  expect(logs.join()).toContain("target_refused");
  expect(logs.join()).toContain("preview-transport-recovered");
  expect(logs.join()).not.toContain("secret");
  expect(logs.join()).not.toContain("Private details");
});

it("rejects the platform runtime port before reading authority", async () => {
  const h = makeHarness();
  const task = new NoSimulationTask("reserved-preview", false);
  const result = await admitPreview(task, h.deps, {
    orbId: "missing",
    port: 8080,
    origin: "https://preview.test",
    expiresAt: task.wallNow() + 60000,
  });
  expect(result.isErr() && result.error.code).toBe("reserved_port");
});

it("records unavailable admission once without paths or credentials", async () => {
  const h = makeHarness();
  const logs: unknown[] = [];
  const task = new NoSimulationTask("preview-telemetry", false);
  task.log = (...values) => {
    logs.push(...values);
  };
  seedRunningOrb(task, h, "orb-a");
  const before = logs.length;
  const request = {
    orbId: "orb-a",
    port: 5173,
    origin: "https://preview.test",
    expiresAt: task.wallNow() + 60000,
  };
  expect((await admitPreview(task, h.deps, request)).isErr()).toBe(true);
  expect((await admitPreview(task, h.deps, request)).isErr()).toBe(true);
  const events = logs.slice(before).filter((value) => String(value).startsWith("lifecycle:"));
  expect(events).toHaveLength(1);
  expect(events.join()).toContain("preview-admission-denied");
  expect(events.join()).not.toContain(request.origin);
});
