import type { ClientAction } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { type AgentGateView, decideRequest, RequestRegistry } from "./requests.ts";

const messageAction = (expectedHeadId: string | null): ClientAction => ({
  type: "message",
  expectedHeadId,
  content: [{ type: "text", text: "do it" }],
});

const idleView = (headId: string | null): AgentGateView => ({
  activity: "idle",
  headId,
  activeOperationId: null,
});

const busyView = (headId: string | null, operationId: string): AgentGateView => ({
  activity: "busy",
  headId,
  activeOperationId: operationId,
});

describe("decideRequest", () => {
  it("accepts a message when idle with a matching head", () => {
    const decision = decideRequest(idleView("rec-5"), messageAction("rec-5"));
    expect(decision).toEqual({ type: "start_message" });
  });

  it("rejects a message while busy", () => {
    const decision = decideRequest(busyView("rec-5", "op-1"), messageAction("rec-5"));
    expect(decision).toMatchObject({ type: "reject", code: "busy" });
  });

  it("rejects a stale head", () => {
    const decision = decideRequest(idleView("rec-9"), messageAction("rec-5"));
    expect(decision).toMatchObject({ type: "reject", code: "stale_head" });
  });

  it("accepts an abort of the active operation", () => {
    const decision = decideRequest(busyView("rec-5", "op-1"), {
      type: "abort",
      operationId: "op-1",
    });
    expect(decision).toEqual({ type: "abort_operation", operationId: "op-1" });
  });

  it("rejects an abort of a finished or unknown operation", () => {
    const idle = decideRequest(idleView("rec-5"), { type: "abort", operationId: "op-1" });
    expect(idle).toMatchObject({ type: "reject", code: "stale_operation" });
    const wrongOp = decideRequest(busyView("rec-5", "op-2"), {
      type: "abort",
      operationId: "op-1",
    });
    expect(wrongOp).toMatchObject({ type: "reject", code: "stale_operation" });
  });
});

describe("RequestRegistry (in-memory request identity, §6.4)", () => {
  it("returns the original result with duplicate: true for identical resends", () => {
    const registry = new RequestRegistry();
    const action = messageAction("rec-1");
    expect(registry.lookup("req-1", action)).toEqual({ type: "new" });
    registry.record("req-1", action, {
      type: "accepted",
      operationId: "op-1",
      duplicate: false,
    });
    const replay = registry.lookup("req-1", messageAction("rec-1"));
    expect(replay).toEqual({
      type: "replay",
      result: { type: "accepted", operationId: "op-1", duplicate: true },
    });
  });

  it("rejects a known id with a different action as request_id_conflict", () => {
    const registry = new RequestRegistry();
    registry.record("req-1", messageAction("rec-1"), {
      type: "accepted",
      operationId: "op-1",
      duplicate: false,
    });
    expect(registry.lookup("req-1", messageAction("rec-2"))).toEqual({ type: "conflict" });
    expect(registry.lookup("req-1", { type: "abort", operationId: "op-1" })).toEqual({
      type: "conflict",
    });
  });

  it("replays rejected outcomes verbatim", () => {
    const registry = new RequestRegistry();
    const action = messageAction("rec-1");
    registry.record("req-1", action, {
      type: "rejected",
      error: { code: "busy", message: "operation in progress", retryable: true },
    });
    const replay = registry.lookup("req-1", action);
    expect(replay).toEqual({
      type: "replay",
      result: {
        type: "rejected",
        error: { code: "busy", message: "operation in progress", retryable: true },
      },
    });
  });
});
