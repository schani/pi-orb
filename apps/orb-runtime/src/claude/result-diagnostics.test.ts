import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeDiagnostics } from "./diagnostics.ts";

const result = (fields: object) =>
  ({ type: "result", subtype: "success", is_error: true, ...fields }) as SDKResultMessage;

it("captures API error text/status without stderr, credentials or arbitrary SDK fields", () => {
  const diagnostics = new ClaudeDiagnostics(["opaque-secret", "secret/value"]);
  diagnostics.stderr("unrelated stderr");
  const captured = diagnostics.result(
    result({
      result:
        "Rate limited opaque-\u001b[31msecret secret%2Fvalue Bearer hidden sk-ant-private " +
        "https://user:pass@example.com/api?token=hidden#hidden",
      api_error_status: 429,
      headers: { authorization: "private header" },
      prompt: "private prompt",
    }),
  );
  expect(captured).toMatchObject({
    category: "api_error",
    errors: [],
    apiErrorStatus: 429,
    truncated: false,
  });
  expect(captured.errorText).toContain("Rate limited");
  expect(captured.errorText).toContain("https://example.com/api");
  for (const secret of [
    "opaque-secret",
    "secret%2Fvalue",
    "hidden",
    "sk-ant-private",
    "user:pass",
    "private",
    "unrelated stderr",
    "\u001b",
  ])
    expect(JSON.stringify(captured)).not.toContain(secret);
});

it("redacts error strings before bounding them and reports omitted diagnostics", () => {
  const diagnostics = new ClaudeDiagnostics(["opaque-secret"]);
  const captured = diagnostics.result(
    result({
      subtype: "error_during_execution",
      errors: Array.from({ length: 20 }, () => `socket opaque-secret ${"x".repeat(2000)}`),
      result: "not an error-variant field",
      api_error_status: 500,
    }),
  );
  expect(captured.category).toBe("error_during_execution");
  expect(captured.errors).toHaveLength(16);
  expect(captured.errors.every((error) => error.length <= 1024)).toBe(true);
  expect(captured.errors[0]).toContain("socket [redacted]");
  expect(captured).toMatchObject({
    errorCount: 20,
    errorText: null,
    apiErrorStatus: null,
    truncated: true,
  });
  expect(JSON.stringify(captured)).not.toContain("opaque-secret");
});

it("bounds API text and retains unavailable status explicitly without guessing from text", () => {
  const diagnostics = new ClaudeDiagnostics([]);
  expect(diagnostics.result(result({ result: `HTTP 403 ${"x".repeat(20000)}` }))).toMatchObject({
    apiErrorStatus: null,
    truncated: true,
  });
  expect(diagnostics.result(result({ result: "x".repeat(20000) })).errorText).toHaveLength(8192);
  expect(diagnostics.result(result({ result: "", api_error_status: null }))).toMatchObject({
    errorText: "",
    apiErrorStatus: null,
    truncated: false,
  });
});

it("redacts assistant text before bounding and excludes non-text content", () => {
  const diagnostics = new ClaudeDiagnostics(["opaque-secret"]);
  const captured = diagnostics.assistant({
    type: "assistant",
    error: "authentication_failed",
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "session",
    message: {
      content: [
        { type: "text", text: `Denied opaque-secret ${"x".repeat(10000)}` },
        { type: "thinking", thinking: "private reasoning", signature: "private signature" },
      ],
    },
  } as unknown as Parameters<ClaudeDiagnostics["assistant"]>[0]);
  expect(captured).toMatchObject({
    category: "authentication_failed",
    apiErrorStatus: null,
    truncated: true,
  });
  expect(captured.errorText).toHaveLength(8192);
  expect(captured.errorText).toContain("Denied [redacted]");
  for (const secret of ["opaque-secret", "private reasoning", "private signature"])
    expect(JSON.stringify(captured)).not.toContain(secret);
});
