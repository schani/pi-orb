import { ProtocolError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { mapMcpSdkError } from "./sdk-error.ts";

const missing = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  error: { code: -32601, message: "Method not found" },
});
it("recognizes explicit method-not-found, including PostHog's HTTP 404 envelope", () => {
  expect(mapMcpSdkError(new ProtocolError(-32601, "Method not found")).code).toBe("unsupported");
  expect(
    mapMcpSdkError(
      new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "remote", {
        status: 404,
        text: missing,
      }),
    ).code,
  ).toBe("unsupported");
});
it.each([
  [401, missing],
  [403, missing],
  [500, missing],
  [404, "<html>Missing endpoint</html>"],
  [404, JSON.stringify({ error: { code: -32601 } })],
  [404, JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "failure" } })],
] as const)("does not hide HTTP %s failures and never publishes remote bodies", (status, text) => {
  const result = mapMcpSdkError(
    new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "private-value", { status, text }),
  );
  expect(result.code).toBe("unavailable");
  expect(result.message).toContain(`HTTP ${status}`);
  expect(result.message).not.toContain("private-value");
  expect(result.message).not.toContain(text);
});
