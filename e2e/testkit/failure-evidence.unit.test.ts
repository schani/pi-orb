import type { HistoryRecord } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { FailureEvidence, failureHistory, failureRequests } from "./failure-evidence.ts";

describe("failure evidence", () => {
  it("retains auth ledger response status and presence without session paths or credentials", () => {
    const rows = [
      [
        "deviceauth/usercode",
        200,
        { device_auth_id: "FORBIDDEN", user_code: "FORBIDDEN", interval: 1 },
      ],
      [
        "deviceauth/token",
        403,
        { error: { code: "deviceauth_authorization_pending", message: "FORBIDDEN" } },
      ],
      ["deviceauth/token", 200, { authorization_code: "FORBIDDEN", code_verifier: "FORBIDDEN" }],
      [
        "oauth/token",
        200,
        { access_token: "FORBIDDEN", refresh_token: "FORBIDDEN", expires_in: 3600 },
      ],
    ] as const;
    const requests = failureRequests(
      rows.map(([category, status, body], index) => ({
        id: index + 1,
        surface: "auth",
        method: "POST",
        path: `/oai/FORBIDDEN/${category === "oauth/token" ? category : `api/accounts/${category}`}?session=FORBIDDEN`,
        createdAt: "2026-10-05T23:58:00.000Z",
        status,
        matchedRuleIndex: null,
        stopReason: null,
        aborted: false,
        finalized: true,
        headers: { authorization: "FORBIDDEN" },
        body: { user_code: "FORBIDDEN" },
        events: [{ kind: "response", status, body }],
      })),
    );
    expect(requests).toHaveLength(4);
    expect(requests.map((row) => row.pathCategory)).toEqual(rows.map((row) => row[0]));
    expect(requests[0]).toMatchObject({
      surface: "auth",
      method: "POST",
      id: 1,
      status: 200,
      aborted: false,
      finalized: true,
      authResponses: [{ status: 200, deviceAuthIdPresent: true, userCodePresent: true }],
    });
    expect(requests[1]).toMatchObject({
      authResponses: [{ status: 403, authorizationPending: true }],
    });
    expect(requests[2]).toMatchObject({
      authResponses: [{ authorizationCodePresent: true, codeVerifierPresent: true }],
    });
    expect(requests[3]).toMatchObject({
      authResponses: [{ accessTokenPresent: true, refreshTokenPresent: true }],
    });
    expect(JSON.stringify(requests)).not.toMatch(/FORBIDDEN|deviceauth_authorization_pending/);
  });
  it("distinguishes model matcher and codec errors without retaining bodies", () => {
    const requests = failureRequests([
      {
        surface: "model",
        body: JSON.stringify({
          model: "gpt-6-luna",
          input: [{ type: "message", role: "user", content: "FORBIDDEN" }],
        }),
        headers: { "content-encoding": "zstd", authorization: "FORBIDDEN" },
        events: [
          {
            kind: "response",
            status: 400,
            body: { error: "no_matching_rule", message: "FORBIDDEN" },
          },
        ],
      },
      {
        surface: "model",
        body: null,
        events: [
          {
            kind: "response",
            status: 400,
            body: { error: "invalid_body", message: "FORBIDDEN" },
          },
        ],
      },
      {
        surface: "model",
        body: "FORBIDDEN",
        events: [{ kind: "response", body: { error: "FORBIDDEN" } }],
      },
    ]);
    expect(requests[0]).toMatchObject({
      modelRequest: { model: "luna", encoding: "zstd", inputCount: 1 },
      modelErrors: ["no_matching_rule"],
    });
    expect(requests[1]).toMatchObject({
      modelRequest: { model: null, inputCount: null },
      modelErrors: ["invalid_body"],
    });
    expect(requests[2]).toMatchObject({ modelErrors: [null] });
    expect(JSON.stringify(requests)).not.toContain("FORBIDDEN");
  });
  it("bounds mixed ledgers and rejects unknown metadata", () => {
    const requests = failureRequests(
      Array.from({ length: 90 }, (_, id) => ({
        id,
        surface: id % 2 ? "model" : "auth",
        method: "FORBIDDEN",
        path: "/FORBIDDEN",
        stopReason: "FORBIDDEN",
        createdAt: "FORBIDDEN",
        events: Array.from({ length: 90 }, () => ({
          kind: "response",
          status: 400,
          body: { error: { code: "FORBIDDEN", message: "FORBIDDEN" } },
        })),
      })),
    );
    expect(requests).toHaveLength(80);
    expect(requests[0]).toMatchObject({
      id: 10,
      method: null,
      pathCategory: null,
      stopReason: null,
    });
    expect(requests[0]?.authResponses).toHaveLength(80);
    expect(
      requests[0]?.authResponses?.every(
        (response) =>
          !response.userCodePresent &&
          !response.accessTokenPresent &&
          !response.authorizationPending &&
          !response.slowDown,
      ),
    ).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("FORBIDDEN");
    expect(failureRequests([{ surface: "FORBIDDEN" }])).toEqual([]);
  });
  it("accepts nullable history heads and drops unsupported record fields", () => {
    expect(
      failureHistory({ cursor: null, headId: null, session: null, records: [] }),
    ).toMatchObject({
      cursor: null,
      headId: null,
      sessionId: null,
      recordCount: 0,
      assistants: [],
      tools: [],
    });
    const history = failureHistory({
      records: [
        {
          type: "message",
          role: "assistant",
          id: "record_1",
          parentId: "record_0",
          finishReason: "FORBIDDEN",
          content: [{ type: "text", text: "FORBIDDEN" }],
          failure: { message: "FORBIDDEN" },
        },
      ],
    });
    expect(history.assistants).toEqual([
      { recordId: "record_1", parentId: "record_0", finishReason: null },
    ]);
    expect(JSON.stringify(history)).not.toContain("FORBIDDEN");
  });
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
        method: "POST",
        path: "/oai/FORBIDDEN/backend-api/codex/responses",
        stopReason: "aborted",
        aborted: true,
        finalized: true,
        body: "SECRET",
        error: "SECRET",
        events: [{ type: "response.completed", data: "SECRET" }],
      },
    ]);
    expect(requests[0]).toMatchObject({
      id: 7,
      status: 200,
      matchedRuleIndex: 7,
      stopReason: "aborted",
    });
    expect(requests[0]).not.toHaveProperty("durationMs");
    const history = failureHistory({
      cursor: "abc123",
      records: [
        {
          id: "abc123",
          parentId: null,
          type: "message",
          role: "assistant",
          finishReason: "toolUse",
          overflow: {},
          timestamp: "2026-10-05T23:58:00.000Z",
          content: [
            { type: "tool_call", callId: "call_1", name: "bash", arguments: "SECRET" },
            {
              type: "tool_result",
              callId: "call_1",
              isError: false,
              content: [{ type: "text", text: "SECRET" }],
            },
          ],
        },
      ] satisfies HistoryRecord[],
      headId: null,
      session: { id: "session_1", overflow: { secret: "SECRET" } },
    });
    expect(history).toMatchObject({
      cursor: "abc123",
      headId: null,
      sessionId: "session_1",
      assistants: [{ recordId: "abc123", parentId: null, finishReason: "toolUse" }],
      tools: [
        { type: "tool_call", name: "bash" },
        { type: "tool_result", isError: false },
      ],
    });
    expect(JSON.stringify({ requests, history })).not.toMatch(/SECRET|FORBIDDEN/);
  });
});
