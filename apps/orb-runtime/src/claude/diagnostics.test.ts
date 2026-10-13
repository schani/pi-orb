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
