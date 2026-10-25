import { expect, it } from "vitest";
import { ClaudeDiagnostics } from "./diagnostics.ts";

it("captures SDK stack/cause and stderr without credentials or arbitrary payloads", () => {
  const diagnostic = new ClaudeDiagnostics(["opaque-secret"]);
  diagnostic.stderr("old line\n" + "x".repeat(40000) + "\nTLS failed opaque-");
  diagnostic.stderr("secret\n");
  diagnostic.exited(17, null);
  const error = Object.assign(
    new Error("Account rejected", { cause: new Error("socket refused") }),
    {
      headers: { token: "hidden" },
      body: { prompt: "private input" },
    },
  );
  const result = diagnostic.capture(error);
  expect(result.message).toContain("Account rejected: caused by: socket refused");
  expect(result.diagnostics).toContain("diagnostics.test.ts");
  expect(result.diagnostics).toContain("TLS failed [redacted]");
  expect(result.diagnostics).toContain("exitCode=17");
  const invalidStack = Object.assign(new Error("safe"), {
    stack: { toString: () => "private input" },
  });
  expect(diagnostic.capture(invalidStack).diagnostics).not.toContain("private input");
  for (const secret of ["opaque-secret", "old line", "hidden", "private input"])
    expect(JSON.stringify(result)).not.toContain(secret);
});

it("redacts credential syntax, encoded secrets, URLs and ANSI-split credentials before bounding", () => {
  const diagnostic = new ClaudeDiagnostics(["opaque-secret", "secret/value"]);
  const text =
    "opaque-\u001b[31msecret secret%2Fvalue token=private Bearer bearer-secret sk-ant-oat01-secret " +
    "https://user:pass@example.com/login?code=private-code#private-fragment";
  const result = diagnostic.capture(new Error(text));
  for (const secret of [
    "opaque-secret",
    "secret%2Fvalue",
    "private",
    "bearer-secret",
    "sk-ant",
    "user:pass",
    "\u001b",
  ])
    expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.diagnostics).toContain("example.com/login");
  const error = new Error("a".repeat(20000));
  error.cause = error;
  expect(diagnostic.capture(error).message.length).toBeLessThanOrEqual(1024);
  expect(diagnostic.capture(error).diagnostics.length).toBeLessThanOrEqual(16384);
  diagnostic.stderr("partial " + "x".repeat(40000));
  expect(diagnostic.capture("failed").diagnostics).not.toContain("xxxx");
});

it("redacts and bounds SDK errors without serializing unrelated fields or stderr", () => {
  const diagnostics = new ClaudeDiagnostics(["opaque-secret"]);
  diagnostics.stderr("private stderr");
  const result = (fields: object) =>
    diagnostics.result({
      type: "result",
      subtype: "success",
      is_error: true,
      ...fields,
    } as Parameters<ClaudeDiagnostics["result"]>[0]);
  const api = result({
    result: `Denied opaque-secret ${"x".repeat(9000)}`,
    api_error_status: 429,
    headers: { authorization: "private header" },
    prompt: "private prompt",
  });
  expect(api).toMatchObject({
    category: "api_error",
    errors: [],
    apiErrorStatus: 429,
    truncated: true,
  });
  expect(api.errorText).toHaveLength(8192);
  expect(api.errorText).toContain("Denied [redacted]");
  expect(result({ result: "HTTP 403" })).toMatchObject({ apiErrorStatus: null, truncated: false });
  expect(result({ result: "", api_error_status: null })).toMatchObject({
    errorText: "",
    apiErrorStatus: null,
  });
  const errors = result({
    subtype: "error_during_execution",
    errors: Array(20).fill(`socket opaque-secret ${"x".repeat(2000)}`),
  });
  expect(errors).toMatchObject({
    category: "error_during_execution",
    errorCount: 20,
    errorText: null,
    apiErrorStatus: null,
    truncated: true,
  });
  expect(errors.errors).toHaveLength(16);
  expect(
    errors.errors.every((error) => error.length === 1024 && error.startsWith("socket [redacted]")),
  ).toBe(true);
  const assistant = diagnostics.assistant({
    error: "authentication_failed",
    message: {
      content: [
        { type: "text", text: `Denied opaque-secret ${"x".repeat(9000)}` },
        { type: "thinking", thinking: "private reasoning", signature: "private signature" },
        { type: "tool_use", name: "private tool", input: { value: "private input" } },
      ],
    },
  } as Parameters<ClaudeDiagnostics["assistant"]>[0]);
  expect(assistant).toMatchObject({
    category: "authentication_failed",
    apiErrorStatus: null,
    truncated: true,
  });
  expect(assistant.errorText).toHaveLength(8192);
  expect(assistant.errorText).toContain("Denied [redacted]");
  expect(JSON.stringify([api, errors, assistant])).not.toMatch(/opaque-secret|private/);
});

it("redacts complete credentials before summary, stack and stderr truncation boundaries", () => {
  const secret = "opaque-boundary-credential";
  const diagnostic = new ClaudeDiagnostics([secret]);
  const message = "a".repeat(1018) + secret;
  const error = new Error(message);
  error.stack = "b".repeat(8186) + secret;
  diagnostic.stderr(secret + "d".repeat(8186));
  const captured = diagnostic.capture(error, "e".repeat(1018) + secret);
  expect(captured.message).toHaveLength(1024);
  expect(captured.message).toBe(`${"a".repeat(1018)}[redac`);
  expect(captured.diagnostics.split("\n")[0]).toBe(`${"e".repeat(1018)}[redac`);
  expect(captured.diagnostics).toContain(`${"b".repeat(8186)}[redac`);
  expect(captured.diagnostics).toContain("stderr:\nacted]");
  expect(JSON.stringify(captured)).not.toContain("opaque");
});

it.each([
  {
    errorClass: "process_exited_nonzero",
    exitCode: 1,
    observedCode: 1,
    signal: null,
    accepted: true,
  },
  {
    errorClass: "error_result",
    exitCode: undefined,
    observedCode: 1,
    signal: null,
    accepted: true,
  },
  {
    errorClass: "error_result",
    exitCode: undefined,
    observedCode: 2,
    signal: null,
    accepted: false,
  },
  {
    errorClass: "error_result",
    exitCode: undefined,
    observedCode: null,
    signal: "SIGTERM",
    accepted: false,
  },
  {
    errorClass: "process_exited_nonzero",
    exitCode: 2,
    observedCode: 1,
    signal: null,
    accepted: false,
  },
  {
    errorClass: "process_killed_by_signal",
    exitCode: 1,
    observedCode: 1,
    signal: null,
    accepted: false,
  },
])(
  "recognizes failed-result exit only from typed SDK error plus observed process status: $errorClass/$exitCode/$observedCode/$signal",
  ({ errorClass, exitCode, observedCode, signal, accepted }) => {
    const diagnostics = new ClaudeDiagnostics([]);
    const error = Object.assign(new Error("arbitrary text"), { errorClass, exitCode });
    expect(diagnostics.isFailedResultExit(error)).toBe(false);
    diagnostics.exited(observedCode, signal);
    expect(diagnostics.isFailedResultExit(error)).toBe(accepted);
    expect(diagnostics.isFailedResultExit(Object.assign(error, { signal: "SIGKILL" }))).toBe(false);
  },
);
