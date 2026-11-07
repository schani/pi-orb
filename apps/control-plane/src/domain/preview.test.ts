import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import {
  admitPreview,
  PREVIEW_VALIDATION_TIMEOUT_MS,
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

for (const scenario of [
  { cause: "runtime-hang", check: "runtime_health", failure: "timeout" },
  { cause: "runtime-unreachable", check: "runtime_health", failure: "error" },
  { cause: "replaced-incarnation", check: "host_observe", failure: "mismatch" },
] as const) {
  it(`records which admission check failed: ${scenario.cause}`, async () => {
    const logs = new LogCapture();
    await runDst(
      { name: `preview-denial-${scenario.cause}`, iterations: 1, logCapture: logs },
      async (sim) => {
        const h = makeHarness();
        const health = h.deps.runtimeClient.health.bind(h.deps.runtimeClient);
        h.deps.runtimeClient.health = (task, url, context) =>
          scenario.cause === "runtime-hang"
            ? ResultAsync.fromPromise(
                task.sleep(60_000, "runtime never answers", { signal: context.signal }),
                () => ({
                  type: "runtime_client_error" as const,
                  answered: false,
                  code: "cancelled" as const,
                  message: "health: cancelled",
                  retryable: true,
                }),
              ).andThen(() => health(task, url, context))
            : health(task, url, context).map((value) =>
                value.status === "ready"
                  ? { ...value, incarnation: 0, executionId: "boot" }
                  : value,
              );
        const result = await sim.runTasks([
          {
            name: "request",
            f: async (task) => {
              seedRunningOrb(task, h, "orb-a");
              const orb = h.store.orbSnapshot("orb-a")!;
              await h.store.registerPreview(task, {
                orbId: orb.id,
                port: 5173,
                registrationId: "r1",
                caller: { runtimeTokenHash: orb.runtimeTokenHash!, hostIncarnation: 0 },
                now: task.wallNow(),
              });
              if (scenario.cause === "runtime-unreachable")
                h.world.setRuntimeUnreachable(task, orb.id, 60_000);
              if (scenario.cause === "replaced-incarnation")
                h.store.seedOrb({ ...orb, hostIncarnation: orb.hostIncarnation + 1 });
              const denied = await admitPreview(task, h.deps, {
                orbId: orb.id,
                port: 5173,
                origin: "https://preview.test",
                expiresAt: task.wallNow() + 60000,
              });
              expect(denied.isErr() && denied.error.code).toBe("stale_target");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    const [line, ...rest] = logs.matching("preview-admission-denied");
    expect(rest).toHaveLength(0);
    expect(line).toContain(
      `reason=stale_target check=${scenario.check} failure=${scenario.failure} elapsedMs=`,
    );
    const elapsedMs = Number(/elapsedMs=(\d+)/u.exec(line ?? "")?.[1]);
    if (scenario.failure === "timeout")
      expect(elapsedMs).toBeGreaterThanOrEqual(PREVIEW_VALIDATION_TIMEOUT_MS);
    else expect(elapsedMs).toBeLessThan(PREVIEW_VALIDATION_TIMEOUT_MS);
  });
}
