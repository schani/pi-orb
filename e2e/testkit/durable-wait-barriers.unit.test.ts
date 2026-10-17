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

it("keeps exact nested execution and outer browser identities for the single bash callback", () => {
  const orb = "b9c685e8-519d-483e-83ee-eff7e6f4163a";
  const operationId = `conversation:${orb}:submission:37`;
  const callId = "call_16|ctc_15";
  const executionCallId = `${callId}/c1`;
  for (const event of [
    "execution.tool_waiting",
    "execution.tool_ready",
    "execution.tool_wait_finished",
  ]) {
    const fields: Record<string, string> = { call_id: executionCallId };
    if (event === "execution.tool_wait_finished") fields["outcome"] = "cancelled";
    const logs = [
      `lifecycle: orb=${orb} ${event} task_id=44 call_id="${executionCallId}"` +
        (fields["outcome"] ? " outcome=cancelled\n" : "\n"),
    ];
    expect(lifecycleEdge(logs, orb, event, fields)).toMatchObject(fields);
    for (const wrongCallId of [callId, "call_other/c1", `${callId}/c2`]) {
      expect(lifecycleEdge(logs, orb, event, { ...fields, call_id: wrongCallId })).toBeUndefined();
    }
    expect(lifecycleEdge(logs, "other", event, fields)).toBeUndefined();
    if (fields["outcome"]) {
      expect(lifecycleEdge(logs, orb, event, { ...fields, outcome: "failed" })).toBeUndefined();
    }
  }
  const event = {
    type: "tool_state",
    operationId,
    callId,
    name: "codemode",
    state: "running",
    message: "Waiting for execution.",
  };
  const frames = [
    { direction: "received", payload: JSON.stringify({ type: "runtime.event", event }) },
  ];
  const fields = { callId, name: "codemode", state: "running", message: event.message };
  expect(operationEvent(frames, operationId, "tool_state", fields)).toEqual(event);
  for (const wrongCallId of [executionCallId, "call_other", `${callId}/c2`]) {
    expect(
      operationEvent(frames, operationId, "tool_state", { ...fields, callId: wrongCallId }),
    ).toBeUndefined();
  }
  expect(operationEvent(frames, "other", "tool_state", fields)).toBeUndefined();
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
