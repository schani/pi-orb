import { describe, expect, it } from "vitest";
import { FailureEvidence, failureHistory, failureRequests } from "./failure-evidence.ts";

describe("failure evidence", () => {
  it("keeps runtime health metadata but drops provider errors", async () => {
    const evidence = new FailureEvidence("spawned");
    await evidence.probe("health", async () => ({
      status: 200,
      body: { status: "failed", error: { message: "SECRET" }, runtimeInstanceId: "runtime_1" },
    }));
    expect(evidence.observations[0]).toMatchObject({
      runtimeStatus: "failed",
      runtimeInstanceId: "runtime_1",
    });
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  });
  it("records HTTP status and challenge presence without challenge values", async () => {
    const evidence = new FailureEvidence("original");
    await evidence.probe("orb", async () => ({
      status: 503,
      body: {
        state: "starting",
        activity: "busy",
        actionRequired: {
          userCode: "SECRET",
          verificationUri: "https://login/?token=SECRET",
        },
        lastError: "SECRET",
        stateDetail: { type: "waiting_for_runtime" },
      },
    }));
    expect(evidence.observations[0]).toMatchObject({
      status: 503,
      state: "starting",
      activity: "busy",
      userCodePresent: true,
      verificationUriPresent: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  });
  it("preserves thrown probes for waitFor while recording only a typed category", async () => {
    const evidence = new FailureEvidence("original");
    const error = Object.assign(new Error("Authorization: SECRET"), { name: "TimeoutError" });
    await expect(
      evidence.probe("orb", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(evidence.observations[0]).toMatchObject({ errorCategory: "timeout" });
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  });
  it("selects the spawned upload target and bounds observations", async () => {
    const evidence = new FailureEvidence("original");
    evidence.target = "spawned";
    for (let i = 0; i < 85; i++)
      await evidence.probe("orb", async () => ({ status: 200, body: {} }));
    expect(evidence.target).toBe("spawned");
    expect(evidence.observations).toHaveLength(80);
    expect(evidence.observations.every((row) => row.target === "spawned")).toBe(true);
  });
  it("allowlists model ledger and tool metadata, never content or errors", () => {
    const requests = failureRequests([
      {
        id: 7,
        surface: "model",
        status: 200,
        matchedRuleIndex: 7,
        createdAt: "2026-10-05T23:58:00.000Z",
        durationMs: 10,
        body: "SECRET",
        error: "SECRET",
        events: [{ type: "response.completed", data: "SECRET" }],
      },
    ]);
    expect(requests[0]).toMatchObject({ id: 7, status: 200, matchedRuleIndex: 7, durationMs: 10 });
    const history = failureHistory({
      cursor: "abc123",
      records: [
        {
          id: "abc123",
          timestamp: "2026-10-05T23:58:00.000Z",
          content: [
            { type: "tool_call", callId: "call_1", name: "bash", arguments: "SECRET" },
            { type: "tool_result", callId: "call_1", isError: false, content: "SECRET" },
          ],
        },
      ],
    });
    expect(history).toMatchObject({
      cursor: "abc123",
      tools: [
        { type: "tool_call", name: "bash" },
        { type: "tool_result", isError: false },
      ],
    });
    expect(JSON.stringify({ requests, history })).not.toContain("SECRET");
  });
});
