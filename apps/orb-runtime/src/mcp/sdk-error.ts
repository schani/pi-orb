import { METHOD_NOT_FOUND, ProtocolError, SdkHttpError } from "@modelcontextprotocol/client";
import { Result } from "neverthrow";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type McpError, mcpError } from "./service.ts";

const MissingMethod = Type.Object({
  jsonrpc: Type.Literal("2.0"),
  id: Type.Union([Type.String(), Type.Number(), Type.Null()]),
  error: Type.Object({ code: Type.Literal(METHOD_NOT_FOUND), message: Type.String() }),
});

/** Inspect only a bounded protocol envelope; never publish remote messages or headers. */
export function mapMcpSdkError(cause: unknown): McpError {
  if (cause instanceof ProtocolError && cause.code === METHOD_NOT_FOUND) {
    return mcpError("unsupported", "MCP method is unsupported");
  }
  if (cause instanceof SdkHttpError && cause.status === 404) {
    const text = cause.data["text"];
    if (typeof text === "string" && text.length <= 16_384) {
      const parsed = Result.fromThrowable(
        () => JSON.parse(text) as unknown,
        () => undefined,
      )();
      if (parsed.isOk() && Check(MissingMethod, parsed.value)) {
        return mcpError("unsupported", "MCP method is unsupported");
      }
    }
  }
  const status = cause instanceof SdkHttpError ? ` (HTTP ${cause.status})` : "";
  return mcpError(
    "unavailable",
    `MCP request failed${status}; check credentials or endpoint. A tool call's outcome may be unknown.`,
  );
}
