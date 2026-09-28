import { expect, it } from "vitest";
import { mcpFailureHistory, mcpFailureRequests } from "./mcp-diagnostics.ts";

it("retains stream termination evidence without bearer headers, prompts, or response bodies", () => {
  const recorded = [
    {
      id: 2,
      surface: "model",
      status: 400,
      matchedRuleIndex: null,
      stopReason: "error",
      aborted: false,
      finalized: true,
      createdAt: "2026-09-27T22:03:10.025Z",
      headers: { authorization: "secret-bearer" },
      body: { instructions: "secret-prompt" },
      events: [
        { kind: "response", status: 400, body: { error: "secret-error" } },
        { type: "secret-prompt" },
      ],
    },
    {
      id: 1,
      surface: "model",
      status: 200,
      matchedRuleIndex: 9,
      stopReason: "aborted",
      aborted: true,
      finalized: true,
      createdAt: "2026-09-27T22:03:07.702Z",
      headers: { authorization: "secret-bearer" },
      body: { instructions: "secret-prompt" },
      events: [{ type: "response.created", response: { id: "secret-response-id" } }],
    },
  ];
  const summary = mcpFailureRequests(recorded);
  expect(summary).toEqual([
    {
      id: 1,
      createdAt: "2026-09-27T22:03:07.702Z",
      status: 200,
      matchedRuleIndex: 9,
      stopReason: "aborted",
      aborted: true,
      finalized: true,
      eventTypes: ["response.created"],
    },
    {
      id: 2,
      createdAt: "2026-09-27T22:03:10.025Z",
      status: 400,
      matchedRuleIndex: null,
      stopReason: "error",
      aborted: false,
      finalized: true,
      eventTypes: ["response", "unknown"],
    },
  ]);
  expect(JSON.stringify(summary)).not.toMatch(/secret-/);
});

it("extracts only the replicated assistant failure transport context", () => {
  const result = mcpFailureHistory({
    records: [
      { role: "user", content: "secret prompt" },
      {
        role: "assistant",
        failure: {
          message: "secret remote body",
          diagnostics: ["stream_aborted"],
          context: {
            transport: "websocket",
            phase: "after_message_stream_start",
            wsCloseCode: 1006,
            requestId: "secret-id",
          },
        },
      },
      {
        role: "assistant",
        failure: {
          message: "secret remote body",
          diagnostics: ["provider_transport_failure"],
          context: { transport: "sse", status: 400 },
        },
      },
    ],
  });
  expect(result).toEqual([
    {
      transport: "websocket",
      phase: "after_message_stream_start",
      wsCloseCode: 1006,
      status: undefined,
      diagnostics: ["stream_aborted"],
    },
    {
      transport: "sse",
      phase: undefined,
      wsCloseCode: undefined,
      status: 400,
      diagnostics: ["provider_transport_failure"],
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/secret/);
  expect(
    JSON.stringify(
      mcpFailureHistory({
        records: [
          {
            role: "assistant",
            failure: {
              diagnostics: ["secret-provider-body"],
              context: {
                transport: "secret-credential",
                phase: "secret-prompt",
                status: "secret-status",
              },
            },
          },
        ],
      }),
    ),
  ).not.toContain("secret-");
});
