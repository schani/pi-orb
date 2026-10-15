import { ClaudeModelCallSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  type ClaudeModelCall,
  parseOtlpLogs,
  startModelUsageReceiver,
  telemetryEnvironment,
} from "./model-usage.ts";

type Value = { stringValue: string } | { intValue: number | string } | { doubleValue: number };
const record = (event: string, attributes: Record<string, Value>) => ({
  timeUnixNano: "1791911708519000000",
  body: { stringValue: `claude_code.${event}` },
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
// Shape captured from Claude Code 2.1.289 (`model-usage.contract.test.ts` pins it).
const apiRequest = record("api_request", {
  "session.id": { stringValue: "f43095cd-78db-42ed-9322-20130857ddec" },
  "event.timestamp": { stringValue: "2026-10-13T17:15:08.519Z" },
  "prompt.id": { stringValue: "4e313ac0-c6f5-4f29-b0b9-0e472ed38b49" },
  model: { stringValue: "claude-sonnet-5-5" },
  input_tokens: { intValue: 101 },
  output_tokens: { intValue: 7 },
  cache_read_tokens: { intValue: "1000" },
  cache_creation_tokens: { intValue: 50 },
  cost_usd: { doubleValue: 0.000597 },
  duration_ms: { intValue: 18 },
  ttft_ms: { intValue: 11 },
  request_id: { stringValue: "req_1" },
  speed: { stringValue: "normal" },
  query_source: { stringValue: "agent:custom" },
  "agent.name": { stringValue: "custom" },
  effort: { stringValue: "medium" },
});
const apiError = record("api_error", {
  "session.id": { stringValue: "f43095cd-78db-42ed-9322-20130857ddec" },
  "event.timestamp": { stringValue: "2026-10-13T17:15:09.000Z" },
  model: { stringValue: "claude-sonnet-5-5" },
  error: { stringValue: "Overloaded" },
  status_code: { stringValue: "529" },
  duration_ms: { intValue: 40 },
  attempt: { intValue: 2 },
  query_source: { stringValue: "sdk" },
});
const userPrompt = record("user_prompt", {
  prompt: { stringValue: "<REDACTED>" },
});

describe("parseOtlpLogs", () => {
  it("extracts every api_request and api_error field, ignoring other events", () => {
    const parsed = parseOtlpLogs(logs("claude-code", userPrompt, apiRequest, apiError));
    // The replicated record contract the control plane validates (docs/model-usage.md).
    for (const call of parsed._unsafeUnwrap())
      expect(Check(ClaudeModelCallSchema, call)).toBe(true);
    expect(parsed._unsafeUnwrap()).toEqual<ClaudeModelCall[]>([
      {
        outcome: "ok",
        at: "2026-10-13T17:15:08.519Z",
        sessionId: "f43095cd-78db-42ed-9322-20130857ddec",
        promptId: "4e313ac0-c6f5-4f29-b0b9-0e472ed38b49",
        model: "claude-sonnet-5-5",
        querySource: "agent:custom",
        agentName: "custom",
        input: 101,
        output: 7,
        cacheRead: 1000,
        cacheWrite: 50,
        costUsd: 0.000597,
        durationMs: 18,
        ttftMs: 11,
        requestId: "req_1",
        speed: "normal",
        effort: "medium",
      },
      {
        outcome: "error",
        at: "2026-10-13T17:15:09.000Z",
        sessionId: "f43095cd-78db-42ed-9322-20130857ddec",
        model: "claude-sonnet-5-5",
        querySource: "sdk",
        error: "Overloaded",
        statusCode: "529",
        durationMs: 40,
        attempt: 2,
      },
    ]);
  });

  it("ignores logs from other services sharing the endpoint", () => {
    expect(parseOtlpLogs(logs("user-app", apiRequest))._unsafeUnwrap()).toEqual([]);
  });

  it("rejects a payload that is not OTLP logs", () => {
    expect(parseOtlpLogs({ resourceLogs: "nope" }).isErr()).toBe(true);
    expect(parseOtlpLogs(null).isErr()).toBe(true);
  });

  it("rejects an api_request without token counts", () => {
    const broken = record("api_request", {
      model: { stringValue: "claude-sonnet-5-5" },
    });
    expect(parseOtlpLogs(logs("claude-code", broken)).isErr()).toBe(true);
  });
});

describe("model usage receiver", () => {
  it("accepts authorized OTLP JSON on loopback and hands calls to the sink", async () => {
    const calls: ClaudeModelCall[] = [];
    const receiver = (await startModelUsageReceiver((call) => calls.push(call)))._unsafeUnwrap();
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
      expect(calls).toEqual([]);

      expect((await post({ authorization }, "{")).status).toBe(400);
      expect((await post({ authorization }, payload)).status).toBe(200);
      expect(calls.map((call) => call.requestId)).toEqual(["req_1"]);
    } finally {
      await receiver.close();
    }
  });
});
