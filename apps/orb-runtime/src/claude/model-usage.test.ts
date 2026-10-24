import { ClaudeModelCallSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  type ClaudeModelCall,
  type OtlpParseError,
  parseOtlpLogs,
  startModelUsageReceiver,
  telemetryEnvironment,
} from "./model-usage.ts";

type Value = { stringValue: string } | { intValue: number | string } | { doubleValue: number };
const record = (event: string, attributes: Record<string, Value>) => ({
  attributes: Object.entries({ "event.name": { stringValue: event }, ...attributes }).map(
    ([key, value]) => ({ key, value }),
  ),
});
const logs = (service: string, ...records: ReturnType<typeof record>[]) => ({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeLogs: [{ logRecords: records }],
    },
  ],
});
// Shape pinned to the real Claude Code binary by `model-usage.contract.test.ts`.
const apiRequest = record("api_request", {
  "event.timestamp": { stringValue: "2026-10-13T17:15:08.519Z" },
  model: { stringValue: "claude-sonnet-5-5" },
  query_source: { stringValue: "agent:custom" },
  input_tokens: { intValue: 101 },
  output_tokens: { intValue: 7 },
  cache_read_tokens: { intValue: "1000" },
  cache_creation_tokens: { intValue: 50 },
  cost_usd: { doubleValue: 0.000597 },
  duration_ms: { intValue: 18 },
});
const apiError = record("api_error", {
  "event.timestamp": { stringValue: "2026-10-13T17:15:09.000Z" },
  model: { stringValue: "claude-sonnet-5-5" },
  error: { stringValue: "Overloaded" },
});

describe("parseOtlpLogs", () => {
  it("extracts api_request and api_error calls, ignoring other events and services", () => {
    const calls = parseOtlpLogs(
      logs("claude-code", record("user_prompt", {}), apiRequest, apiError),
    )._unsafeUnwrap();
    expect(calls).toEqual<ClaudeModelCall[]>([
      {
        at: "2026-10-13T17:15:08.519Z",
        model: "claude-sonnet-5-5",
        querySource: "agent:custom",
        outcome: "ok",
        input: 101,
        output: 7,
        cacheRead: 1000,
        cacheWrite: 50,
        costUsd: 0.000597,
        durationMs: 18,
      },
      {
        at: "2026-10-13T17:15:09.000Z",
        model: "claude-sonnet-5-5",
        outcome: "error",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
    // The replicated record contract the control plane validates (docs/model-usage.md).
    for (const call of calls) expect(Check(ClaudeModelCallSchema, call)).toBe(true);
    expect(parseOtlpLogs(logs("user-app", apiRequest))._unsafeUnwrap()).toEqual([]);
  });

  it.each([
    ["non-OTLP payload", null],
    ["malformed resourceLogs", { resourceLogs: "nope" }],
    [
      "api_request without counts",
      logs(
        "claude-code",
        record("api_request", {
          "event.timestamp": { stringValue: "2026-10-13T17:15:08.519Z" },
          model: { stringValue: "claude-sonnet-5-5" },
        }),
      ),
    ],
  ])("rejects a %s", (_, body) => {
    expect(parseOtlpLogs(body).isErr()).toBe(true);
  });
});

describe("model usage receiver", () => {
  it("accepts authorized OTLP JSON on loopback and hands calls to the sink", async () => {
    const calls: ClaudeModelCall[] = [];
    const rejected: OtlpParseError[] = [];
    const receiver = (
      await startModelUsageReceiver(
        (call) => calls.push(call),
        (error) => rejected.push(error),
      )
    )._unsafeUnwrap();
    try {
      const env = telemetryEnvironment(receiver);
      const endpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "";
      expect(new URL(endpoint).hostname).toBe("127.0.0.1");
      const authorization = (env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? "").replace(
        /^authorization=/,
        "",
      );
      const post = (headers: Record<string, string>, body: string) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        });
      const payload = JSON.stringify(logs("claude-code", apiRequest));
      expect((await post({}, payload)).status).toBe(401);
      expect((await post({ authorization: "Bearer wrong" }, payload)).status).toBe(401);
      expect((await post({ authorization }, "{")).status).toBe(400);
      expect(rejected).toEqual([{ code: "invalid_otlp_logs", message: "Body is not JSON." }]);
      expect(
        (await post({ authorization }, JSON.stringify({ PRIVATE_SENTINEL: true }))).status,
      ).toBe(400);
      expect(rejected).toHaveLength(2);
      expect(rejected[1]).toMatchObject({ code: "invalid_otlp_logs" });
      expect(JSON.stringify(rejected)).not.toContain("PRIVATE_SENTINEL");
      expect(JSON.stringify(rejected)).not.toContain(authorization);
      expect(calls).toEqual([]);
      expect((await post({ authorization }, payload)).status).toBe(200);
      expect(calls.map((call) => call.input)).toEqual([101]);
    } finally {
      await receiver.close();
    }
  });
});
