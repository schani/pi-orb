import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { StreamTelemetry } from "../stream-telemetry.ts";
import { createStreamTelemetryExtension } from "./stream-telemetry.ts";

it("measures hidden provider args before normalization and audits anomalous terminal only", () => {
  const telemetry = new StreamTelemetry(() => 100);
  const handlers = new Map<string, (event: never, context: never) => void>();
  const audits: unknown[] = [];
  const extension = createStreamTelemetryExtension({
    telemetry,
    operationId: () => "op",
    rootSessionId: () => "root",
    audit: (edge) => {
      audits.push(edge);
      return ok(undefined);
    },
    failed: () => {
      expect.fail("unexpected persistence failure");
    },
  });
  extension({
    on: (name: string, handler: (event: never, context: never) => void) =>
      handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown) =>
    handlers.get(name)?.(
      event as never,
      { sessionManager: { getSessionId: () => "child" } } as never,
    );
  emit("before_provider_request", { payload: { prompt: "SECRET" } });
  emit("provider_stream_event", {
    data: { type: "response.function_call_arguments.delta", delta: "x".repeat(1_048_576) },
  });
  expect(telemetry.snapshot()).toMatchObject([
    {
      operationId: "op",
      sessionId: "child",
      parentSessionId: "root",
      toolArgumentBytes: 1_048_576,
      normalizedEvents: 0,
    },
  ]);
  expect(audits).toMatchObject([{ edge: "large_tool_arguments" }]);
  emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "SECRET" } });
  expect(telemetry.snapshot()[0]?.normalizedEvents).toBe(1);
  emit("message_end", {
    message: { role: "assistant", stopReason: "aborted", errorMessage: "SECRET" },
  });
  expect(audits).toMatchObject([
    { edge: "large_tool_arguments" },
    { edge: "terminal", terminal: "aborted" },
  ]);
  expect(telemetry.snapshot()).toEqual([]);
  expect(JSON.stringify(audits)).not.toContain("SECRET");
  emit("before_provider_request", { payload: "SECRET" });
  emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  expect(audits).toHaveLength(2);
  emit("session_shutdown", {});
  emit("before_provider_request", { payload: "SECRET" });
  emit("provider_stream_event", { data: { type: "response.output_text.delta", delta: "SECRET" } });
  expect(telemetry.snapshot()).toEqual([]);
});
