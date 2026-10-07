import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { RuntimeHealthSchema } from "./runtime-http.ts";
import { RuntimeStreamStatsSchema } from "./stream-telemetry.ts";

it("ready health carries bounded content-free stream statistics only", () => {
  const stream = {
    requestId: "local",
    operationId: "op",
    sessionId: "root",
    attempt: 1,
    startedAt: 100,
    firstEventAt: null,
    lastEventAt: null,
    lastEventType: null,
    events: 0,
    normalizedEvents: 0,
    normalizedToolArgumentEvents: 0,
    toolArgumentEvents: 0,
    lastNormalizedAt: null,
    textBytes: 0,
    reasoningBytes: 0,
    toolArgumentBytes: 0,
    phase: "waiting",
    transport: "unknown",
    httpResponses: 0,
    httpStatus: null,
    issues: [],
  };
  expect(
    Check(RuntimeHealthSchema, {
      v: 1,
      orbId: "orb",
      runtimeInstanceId: "instance",
      status: "ready",
      sessionId: "root",
      checkoutCommit: "abc",
      activity: "busy",
      streams: [stream],
      streamTelemetryError: "persistence_failed",
    }),
  ).toBe(true);
  expect(Check(RuntimeStreamStatsSchema, { ...stream, arguments: "SECRET" })).toBe(false);
  expect(
    Check(RuntimeStreamStatsSchema, { ...stream, issues: Array(3).fill("no_event_gap") }),
  ).toBe(false);
});
