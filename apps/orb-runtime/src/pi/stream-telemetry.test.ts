import { describe, expect, it } from "vitest";
import { StreamTelemetry } from "./stream-telemetry.ts";

function setup() {
  let now = 100;
  const telemetry = new StreamTelemetry(() => now);
  const request = telemetry.start({
    requestId: "local-1",
    operationId: "op",
    sessionId: "root",
    attempt: 1,
  });
  return {
    telemetry,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("content-free stream telemetry", () => {
  it("recognizes the SDK response.done completion alias without retaining payload", () => {
    const { telemetry, request } = setup();
    telemetry.providerEvent(request, { type: "response.done", response: { secret: "SECRET" } });
    expect(telemetry.snapshot()[0]?.lastEventType).toBe("response.done");
    expect(JSON.stringify(telemetry.snapshot())).not.toContain("SECRET");
  });
  it("uses monotonic gaps even when the wall clock jumps", () => {
    let wall = 100;
    let mono = 0;
    const telemetry = new StreamTelemetry(
      () => wall,
      () => mono,
    );
    telemetry.start({ requestId: "id", operationId: "op", sessionId: "root", attempt: 1 });
    wall += 86_400_000;
    expect(telemetry.poll()).toEqual([]);
    wall = 0;
    mono = 60_000;
    expect(telemetry.poll()).toMatchObject([{ edge: "no_event_gap", observedAt: 0 }]);
  });
  it("distinguishes received hidden arguments from parser progress without retaining content", () => {
    const { telemetry, request, advance } = setup();
    advance(10);
    telemetry.providerEvent(request, {
      type: "response.function_call_arguments.delta",
      delta: "秘密🔑",
      prompt: "SECRET",
    });
    expect(telemetry.snapshot()).toMatchObject([
      {
        phase: "tool_arguments",
        events: 1,
        toolArgumentBytes: 10,
        firstEventAt: 110,
        lastEventAt: 110,
        normalizedEvents: 0,
      },
    ]);
    telemetry.normalizedEvent(request, "toolcall_delta");
    expect(telemetry.snapshot()[0]?.normalizedEvents).toBe(1);
    expect(JSON.stringify(telemetry.snapshot())).not.toMatch(/秘密|SECRET|🔑/);
  });

  it("counts custom grammar tool inputs as hidden toolargument generation", () => {
    const { telemetry, request } = setup();
    telemetry.providerEvent(request, {
      type: "response.custom_tool_call_input.delta",
      delta: "秘密🔑",
    });
    expect(telemetry.snapshot()).toMatchObject([
      {
        phase: "tool_arguments",
        toolArgumentBytes: 10,
        toolArgumentEvents: 1,
        lastEventType: "response.custom_tool_call_input.delta",
      },
    ]);
  });

  it("warns once at 64 KiB, detects the 389502-byte incident, and keeps smaller successful requests quiet", () => {
    const { telemetry, request } = setup();
    telemetry.providerEvent(request, {
      type: "response.function_call_arguments.delta",
      delta: "x".repeat(65_535),
    });
    expect(telemetry.poll()).toEqual([]);
    telemetry.providerEvent(request, {
      type: "response.function_call_arguments.delta",
      delta: "x",
    });
    expect(telemetry.poll()).toMatchObject([
      { edge: "large_tool_arguments", toolArgumentBytes: 65_536 },
    ]);
    telemetry.providerEvent(request, {
      type: "response.function_call_arguments.delta",
      delta: "x".repeat(389_502 - 65_536),
    });
    expect(telemetry.poll()).toEqual([]);
    expect(telemetry.finish(request, "completed")).toMatchObject({
      edge: "terminal",
      terminal: "completed",
      toolArgumentBytes: 389_502,
    });
    const normal = telemetry.start({
      requestId: "normal",
      operationId: "op",
      sessionId: "root",
      attempt: 2,
    });
    telemetry.providerEvent(normal, {
      type: "response.function_call_arguments.delta",
      delta: "x".repeat(1024),
    });
    expect(telemetry.poll()).toEqual([]);
    expect(telemetry.finish(normal, "completed")).toBeNull();
  });

  it("records each anomaly once and only affected terminal summaries", () => {
    const { telemetry, request, advance } = setup();
    expect(telemetry.poll()).toEqual([]);
    advance(60_000);
    expect(telemetry.poll()).toMatchObject([{ edge: "no_event_gap", requestId: "local-1" }]);
    expect(telemetry.poll()).toEqual([]);
    telemetry.providerEvent(request, {
      type: "response.function_call_arguments.delta",
      delta: "x".repeat(1_048_576),
    });
    expect(telemetry.poll()).toMatchObject([{ edge: "large_tool_arguments" }]);
    expect(telemetry.poll()).toEqual([]);
    expect(telemetry.finish(request, "aborted")).toMatchObject({
      edge: "terminal",
      terminal: "aborted",
      toolArgumentBytes: 1_048_576,
    });
    expect(telemetry.finish(request, "aborted")).toBeNull();
    expect(telemetry.snapshot()).toEqual([]);
  });

  it("keeps healthy completion silent, errors inspectable, and stale callbacks isolated", () => {
    const { telemetry, request } = setup();
    expect(telemetry.finish(request, "completed")).toBeNull();
    const next = telemetry.start({
      requestId: "local-2",
      operationId: "op",
      sessionId: "root",
      attempt: 2,
    });
    telemetry.providerEvent(request, { type: "response.output_text.delta", delta: "old" });
    expect(telemetry.snapshot()[0]?.events).toBe(0);
    expect(telemetry.finish(next, "failed")).toMatchObject({
      requestId: "local-2",
      attempt: 2,
      terminal: "failed",
    });
  });

  it("allows only known event types, measures UTF-8 delta bytes, not serialized events", () => {
    const { telemetry, request } = setup();
    telemetry.providerEvent(request, { type: "secret event name", delta: "SECRET" });
    telemetry.providerEvent(request, { type: "response.reasoning_summary_text.delta", delta: "é" });
    telemetry.providerEvent(request, { type: "response.output_text.delta", delta: "a" });
    expect(telemetry.snapshot()).toMatchObject([
      {
        events: 3,
        textBytes: 1,
        reasoningBytes: 2,
        toolArgumentBytes: 0,
        lastEventType: "response.output_text.delta",
      },
    ]);
    expect(JSON.stringify(telemetry.snapshot())).not.toMatch(/secret|SECRET/);
  });

  it("returns independent bounded snapshots and correlates concurrent children", () => {
    const { telemetry } = setup();
    telemetry.start({
      requestId: "child-1",
      operationId: "op",
      sessionId: "child",
      parentSessionId: "root",
      attempt: 1,
    });
    const snapshot = telemetry.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[1]).toMatchObject({ parentSessionId: "root", sessionId: "child" });
    const first = snapshot[0];
    if (!first) throw new Error("missing snapshot");
    first.events = 500;
    expect(telemetry.snapshot()[0]?.events).toBe(0);
  });
});
