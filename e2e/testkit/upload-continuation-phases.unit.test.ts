import { expect, it } from "vitest";
import { UploadContinuationPhases, uploadPhaseTail } from "./upload-continuation-phases.ts";

it("serializes only bounded phase metadata, rejecting secrets and malformed fields", () => {
  expect(
    uploadPhaseTail([
      {
        stage: "headers",
        at: 2,
        operationId: "op-1",
        callId: "call_1|fc_1",
        requestId: "request-1",
        Authorization: "secret",
        url: "https://secret",
        payload: "secret",
      },
    ]),
  ).toEqual([
    { stage: "headers", at: 2, operationId: "op-1", callId: "call_1|fc_1", requestId: "request-1" },
  ]);
  expect(
    uploadPhaseTail([
      { stage: "invented", at: 1 },
      { stage: "end", at: NaN },
      { stage: "error", at: -1 },
    ]),
  ).toEqual([]);
  expect(
    uploadPhaseTail([
      { stage: "error", at: 0, operationId: "https://token", callId: "x".repeat(101) },
    ]),
  ).toEqual([{ stage: "error", at: 0, operationId: null, callId: null, requestId: null }]);
  expect(uploadPhaseTail(null)).toEqual([]);
  expect(
    uploadPhaseTail(Array.from({ length: 100 }, (_, at) => ({ stage: "request", at }))),
  ).toHaveLength(80);
});

it("records immutable bounded snapshots and correlates subsequent provider edges", () => {
  let at = 0;
  const phases = new UploadContinuationPhases(() => at++);
  phases.operation("op-1");
  phases.record("toolresult", "call-1");
  phases.record("providerprepare");
  phases.record("request");
  expect(phases.tail().map((row) => [row.stage, row.operationId, row.callId, row.at])).toEqual([
    ["toolresult", "op-1", "call-1", 0],
    ["providerprepare", "op-1", "call-1", 1],
    ["request", "op-1", "call-1", 2],
  ]);
  phases.tail().pop();
  expect(phases.tail()).toHaveLength(3);
  for (let n = 0; n < 100; n++) phases.record("firstevent");
  expect(phases.tail()).toHaveLength(80);
});

it("captures only public completion edges without inventing provider progress", () => {
  const phases = new UploadContinuationPhases(() => 1);
  phases.observeFrame(null);
  phases.observeFrame({
    type: "runtime.event",
    event: { type: "operation_started", operationId: "op" },
  });
  phases.observeFrame({
    type: "runtime.event",
    event: { type: "tool_state", state: "running", callId: "call" },
  });
  phases.observeFrame({
    type: "runtime.event",
    event: { type: "tool_state", state: "completed", callId: "call", output: "secret" },
  });
  phases.observeFrame({
    type: "history.record",
    record: { type: "message", role: "assistant", finishReason: "toolUse" },
  });
  phases.observeFrame({
    type: "history.record",
    record: {
      type: "message",
      role: "assistant",
      finishReason: "error",
      failure: { message: "secret" },
    },
  });
  phases.observeFrame({
    type: "runtime.event",
    event: { type: "operation_finished", operationId: "other", outcome: "completed" },
  });
  phases.observeFrame({
    type: "runtime.event",
    event: { type: "operation_finished", operationId: "op", outcome: "failed", message: "secret" },
  });
  expect(phases.tail().map((row) => row.stage)).toEqual([
    "toolresult",
    "error",
    "operationretired",
  ]);
  expect(JSON.stringify(phases.tail())).not.toContain("secret");
});
