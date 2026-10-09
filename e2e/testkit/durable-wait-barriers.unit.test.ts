import type { HistoryRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import {
  committedToolOutput,
  lifecycleEdge,
  operationEvent,
  summaryOutcome,
} from "./durable-wait-barriers.ts";

it("requires successful committed tool output, not marker text in a model command or failed result", () => {
  const record: HistoryRecord = {
    id: "result",
    parentId: null,
    timestamp: "now",
    overflow: {},
    type: "message",
    role: "tool",
    content: [
      {
        type: "tool_result",
        callId: "call",
        content: [{ type: "text", text: "VM_EXECUTED_ONCE" }],
      },
    ],
  };
  expect(committedToolOutput([record], "VM_EXECUTED_ONCE")).toBe(true);
  expect(committedToolOutput([{ ...record, role: "assistant" }], "VM_EXECUTED_ONCE")).toBe(false);
  expect(
    committedToolOutput(
      [
        {
          ...record,
          content: [
            {
              type: "tool_result",
              callId: "call",
              isError: true,
              content: [{ type: "text", text: "VM_EXECUTED_ONCE" }],
            },
          ],
        },
      ],
      "VM_EXECUTED_ONCE",
    ),
  ).toBe(false);
});

it("requires exact orb, operation and event identities, including split stdout chunks", () => {
  const logs = [
    "lifecycle: orb=other harness.summary_completed operationId=op\n",
    "lifecycle: orb=orb harness.summary_",
    "completed operationId=other\nlifecycle: orb=orb harness.summary_completed operationId=op\n",
  ];
  expect(summaryOutcome(logs, "orb", "op")).toBe("completed");
  expect(summaryOutcome(logs, "orb", "missing")).toBe("pending");
  expect(
    lifecycleEdge(logs, "orb", "harness.summary_complete", { operationId: "op" }),
  ).toBeUndefined();
});

it("excludes a previous turn's summary even when its operation token is reused", () => {
  const previous = "lifecycle: orb=orb harness.summary_completed operationId=op\n";
  const checkpoint = previous.length;
  const logs = [previous, "lifecycle: orb=orb harness.summary_queued operationId=op\n"];
  expect(summaryOutcome([logs.join("").slice(checkpoint)], "orb", "op")).toBe("pending");
});

it("surfaces scoped summary failure instead of waiting for impossible fixture progress", () => {
  expect(
    summaryOutcome(
      ["lifecycle: orb=orb harness.summary_failed operationId=op reason=inference_failed\n"],
      "orb",
      "op",
    ),
  ).toBe("failed");
});

it("requires model tool publication and waiting for the same operation/call", () => {
  const event = {
    type: "tool_state",
    operationId: "op",
    callId: "call",
    name: "codemode",
    state: "running",
    message: "Waiting for execution.",
  };
  const frames = [
    { direction: "received", payload: JSON.stringify({ type: "runtime.event", event }) },
  ];
  expect(operationEvent(frames, "op", "tool_state", { callId: "call", state: "running" })).toEqual(
    event,
  );
  expect(operationEvent(frames, "other", "tool_state")).toBeUndefined();
  expect(operationEvent(frames, "op", "tool_state", { callId: "other" })).toBeUndefined();
  expect(
    operationEvent([{ ...frames[0]!, direction: "sent" }], "op", "tool_state"),
  ).toBeUndefined();
});
