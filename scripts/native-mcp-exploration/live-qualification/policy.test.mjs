import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exactReviewedCall,
  redactResponseExcerpt,
  summarizeApplicationRead,
  summarizeCall,
  summarizeCloudflareRead,
  summarizeDatadogRead,
  summarizeGrant,
  summarizeReadShape,
} from "./policy.mjs";

test("read response classifier emits only closed semantic indicators", () => {
  const result = (data) => ({
    isError: false,
    content: [{ type: "text", text: JSON.stringify(data) }],
  });
  assert.deepEqual(
    summarizeApplicationRead(
      result({ status: "success", results: [{ name: "PRIVATE_MONITOR" }], total: 1 }),
    ),
    { outcome: "success", truncated: false, keys: ["status", "results", "total"], resultCount: 1 },
  );
  assert.deepEqual(
    summarizeApplicationRead(result({ status: "error", error: "PRIVATE_FAILURE" })),
    { outcome: "error", truncated: false, keys: ["status", "error"] },
  );
  assert.deepEqual(
    summarizeApplicationRead({
      isError: false,
      content: [{ type: "text", text: "Warning: truncated output (private details)" }],
    }),
    { outcome: "unknown", truncated: true, keys: [] },
  );
  assert.deepEqual(
    summarizeApplicationRead({
      isError: true,
      content: [{ type: "text", text: "PRIVATE_FAILURE" }],
    }),
    { outcome: "error", truncated: false, keys: [] },
  );
  assert.equal(
    JSON.stringify(summarizeApplicationRead(result({ random: "PRIVATE_FAILURE" }))).includes(
      "PRIVATE_FAILURE",
    ),
    false,
  );
});

test("multi-text fenced JSON and Markdown expose only known safe application markers", () => {
  const result = (texts) => ({
    isError: false,
    content: texts.map((text) => ({ type: "text", text })),
  });
  assert.deepEqual(
    summarizeApplicationRead(
      result([
        "PRIVATE_MONITOR",
        '```json\n{"status":"success","monitors":[{"name":"SECRET"}]}\n```',
      ]),
    ),
    { outcome: "success", truncated: false, keys: ["status", "monitors"], resultCount: 1 },
  );
  assert.deepEqual(
    summarizeApplicationRead(result(["# PRIVATE_MONITOR\nStatus: success\nResults: 1"])),
    { outcome: "success", truncated: false, keys: ["status", "results"] },
  );
  assert.deepEqual(summarizeApplicationRead(result(["# PRIVATE_MONITOR\nUnexpected payload"])), {
    outcome: "unknown",
    truncated: false,
    keys: [],
  });
  assert.equal(
    JSON.stringify(summarizeApplicationRead(result(["Status: success\nPRIVATE_MONITOR"]))).includes(
      "PRIVATE_MONITOR",
    ),
    false,
  );
});

test("embedded list envelopes require provider-specific structure, never MCP status alone", () => {
  const result = (text) => ({ isError: false, content: [{ type: "text", text }] });
  assert.deepEqual(
    summarizeApplicationRead(result('Result:\n{"count":1,"results":[{"id":7,"name":"PRIVATE"}]}')),
    { outcome: "success", truncated: false, keys: ["results", "count"], resultCount: 1 },
  );
  assert.deepEqual(summarizeApplicationRead(result('Result:\n{"count":1,"results":"PRIVATE"}')), {
    outcome: "unknown",
    truncated: false,
    keys: ["results", "count"],
  });
  assert.equal(
    JSON.stringify(
      summarizeApplicationRead(
        result('Result:\n{"count":1,"results":[{"id":7,"name":"PRIVATE"}]}'),
      ),
    ).includes("PRIVATE"),
    false,
  );
});

test("explicit errors dominate and arbitrary arrays never prove read success", () => {
  const result = (value, isError = false) => ({
    isError,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
  for (const value of [
    [],
    [{ error: "secret" }],
    [{ name: "secret" }],
    { status: "success", error: "secret" },
  ]) {
    assert.notEqual(summarizeApplicationRead(result(value)).outcome, "success");
    assert.equal(summarizeApplicationRead(result(value, true)).outcome, "error");
  }
  assert.equal(
    summarizeApplicationRead({
      isError: true,
      content: [{ type: "text", text: "Status: success\\nResults: 1" }],
    }).outcome,
    "error",
  );
  assert.equal(
    summarizeApplicationRead(result({ results: [{ error: "secret" }] })).outcome,
    "unknown",
  );
});

test("bounded rendering preserves structure but removes record and credential values", () => {
  const text =
    'Result:\ncount: 1\nid: 123\nname: Private Dashboard\nurl: https://private.example/x\nAuthorization: Bearer abc.def.ghi\n{"results":[{"description":"secret","query":"select * from private"}]}';
  const excerpt = redactResponseExcerpt({ content: [{ type: "text", text }] });
  assert.ok(excerpt.length <= 1000);
  assert.match(excerpt, /Result:/);
  assert.match(excerpt, /count:/);
  assert.match(excerpt, /results/);
  assert.match(
    redactResponseExcerpt({ content: [{ type: "text", text: "dashboards[1]:\\n  - id: 99" }] }),
    /dashboards\[x\]:/,
  );
  assert.match(
    redactResponseExcerpt({
      content: [
        {
          type: "text",
          text: "<error>Token budget too low. Set max_tokens at least 1000.</error>",
        },
      ],
    }),
    /<error>.*(?:max_tokens|least)/,
  );
  for (const secret of [
    "123",
    "Private",
    "Dashboard",
    "private.example",
    "abc",
    "def",
    "ghi",
    "select",
    "secret",
  ])
    assert.equal(excerpt.includes(secret), false);
});

test("PostHog indexed YAML requires count and matching read records, not an error", () => {
  const result = (text, isError = false) => ({ isError, content: [{ type: "text", text }] });
  assert.deepEqual(
    summarizeApplicationRead(result('count: 1\nresults[1]:\n  - id: 7\n    name: "private"')),
    {
      outcome: "success",
      truncated: false,
      keys: ["count", "results"],
      resultCount: 1,
      totalCount: 1,
    },
  );
  assert.deepEqual(
    summarizeApplicationRead(result("count: 23\nresults[1]:\n  - id: 7\n    name: private")),
    {
      outcome: "success",
      truncated: false,
      keys: ["count", "results"],
      resultCount: 1,
      totalCount: 23,
    },
  );
  for (const text of [
    "count: 1\nresults[1]:\n  - error: private",
    "count: 1\nresults[2]:\n  - id: 7\n    name: private",
    "count: 1\nresults[1]:\n  - id: 7\n    name: private\nerror: denied",
  ])
    assert.notEqual(summarizeApplicationRead(result(text)).outcome, "success");
  assert.equal(
    summarizeApplicationRead(result("count: 1\nresults[1]:\n  - id: 7\n    name: private", true))
      .outcome,
    "error",
  );
});

test("Datadog metadata distinguishes token truncation from a complete read", () => {
  const result = (body, isError = false) => ({ isError, content: [{ type: "text", text: body }] });
  assert.deepEqual(
    summarizeDatadogRead(
      result(
        "<METADATA><is_truncated>true</is_truncated><truncation_message>Increase max_tokens to see the result</truncation_message><displayed_items>0</displayed_items></METADATA><JSON_DATA>\n\n</JSON_DATA>",
      ),
    ),
    { outcome: "truncated", displayedItems: 0, maxTokensHint: true },
  );
  assert.deepEqual(
    summarizeDatadogRead(
      result(
        "<METADATA><is_truncated>false</is_truncated><displayed_items>0</displayed_items></METADATA><JSON_DATA>\n[]\n</JSON_DATA>",
      ),
    ),
    { outcome: "success", displayedItems: 0, resultCount: 0 },
  );
  assert.equal(
    summarizeDatadogRead(
      result(
        '<METADATA><is_truncated>false</is_truncated><displayed_items>1</displayed_items></METADATA><JSON_DATA>\n{"error":"secret"}\n</JSON_DATA>',
      ),
    ).outcome,
    "error",
  );
  assert.equal(
    summarizeDatadogRead(
      result(
        "<METADATA><is_truncated>false</is_truncated><displayed_items>0</displayed_items></METADATA><JSON_DATA></JSON_DATA>",
        true,
      ),
    ).outcome,
    "error",
  );
  assert.deepEqual(
    summarizeDatadogRead(
      result(
        "<METADATA><message>No monitors found. Try a broader search.</message></METADATA><JSON_DATA>\n\n</JSON_DATA>",
      ),
    ),
    { outcome: "success", resultCount: 0 },
  );
  assert.deepEqual(
    summarizeDatadogRead(
      result(
        "<METADATA><message>No monitors were returned for a query.</message></METADATA><JSON_DATA>\n\n</JSON_DATA>",
      ),
    ),
    { outcome: "success", resultCount: 0 },
  );
  assert.deepEqual(
    summarizeDatadogRead(
      result(
        "<METADATA><message>No data returned for a query. The query is too restrictive, try removing filters.</message></METADATA><JSON_DATA>\n\n</JSON_DATA>",
      ),
    ),
    { outcome: "success", resultCount: 0 },
  );
  assert.notEqual(
    summarizeDatadogRead(
      result(
        "<METADATA><message>Permission denied PRIVATE_MONITOR</message></METADATA><JSON_DATA>\n\n</JSON_DATA>",
      ),
    ).outcome,
    "success",
  );
  assert.equal(
    JSON.stringify(
      summarizeDatadogRead(
        result(
          "<METADATA><message>Permission denied PRIVATE_MONITOR</message></METADATA><JSON_DATA>\n\n</JSON_DATA>",
        ),
      ),
    ).includes("PRIVATE_MONITOR"),
    false,
  );
});

test("normal broker grant evidence excludes tokens and unknown properties", () => {
  const evidence = summarizeGrant("datadog", {
    generation: 90,
    expiresAt: 1790800000000,
    accessToken: "PRIVATE_BEARER",
    private: "PRIVATE",
  });
  assert.deepEqual(evidence, { server: "datadog", generation: 90, expiresAt: 1790800000000 });
  assert.equal(JSON.stringify(evidence).includes("PRIVATE"), false);
});

test("unclassified provider content yields only bounded shape and known key indicators", () => {
  const shape = summarizeReadShape({
    content: [{ type: "text", text: '```json\n[{"name":"PRIVATE_MONITOR","id":12}]\n```' }],
  });
  assert.deepEqual(shape, {
    formats: ["fenced_json_array"],
    knownKeys: ["id", "name"],
    textCount: 1,
  });
  assert.equal(JSON.stringify(shape).includes("PRIVATE_MONITOR"), false);
  assert.deepEqual(
    summarizeReadShape({
      content: [{ type: "text", text: 'Output:\n{"results":[{"name":"PRIVATE"}]}' }],
    }),
    {
      formats: ["plain"],
      knownKeys: ["results", "name"],
      textCount: 1,
      markers: ["output"],
      jsonCandidate: "object",
    },
  );
  assert.deepEqual(
    summarizeReadShape({
      content: [{ type: "text", text: "<Error><Message>PRIVATE</Message></Error>" }],
    }).xmlTags,
    ["Error", "Message"],
  );
  assert.deepEqual(summarizeReadShape({ content: [{ type: "text", text: "PRIVATE_MONITOR" }] }), {
    formats: ["plain"],
    knownKeys: [],
    textCount: 1,
  });
});

test("Cloudflare call requires an executed API response with safe status/count", () => {
  const text = (data) => ({
    isError: false,
    content: [{ type: "text", text: JSON.stringify(data) }],
  });
  assert.deepEqual(
    summarizeCloudflareRead(text({ success: true, status: 200, count: 1, private: "hidden" })),
    { apiSuccess: true, apiStatus: 200, count: 1 },
  );
  assert.deepEqual(summarizeCloudflareRead(text({ success: false, status: 403, count: 0 })), {
    apiSuccess: false,
    apiStatus: 403,
    count: 0,
  });
  assert.deepEqual(summarizeCloudflareRead(text({ success: true })), { apiSuccess: "unverified" });
  assert.deepEqual(summarizeCloudflareRead({ isError: true, content: [] }), {
    apiSuccess: "unverified",
  });
});

test("generic code calls require exact reviewed tool and arguments", () => {
  const reviewed = {
    cloudflare: {
      execute: {
        code: "async () => cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } })",
      },
    },
  };
  assert.equal(
    exactReviewedCall("cloudflare", "execute", reviewed.cloudflare.execute, reviewed),
    true,
  );
  for (const code of [
    "async () => cloudflare.request({ method: 'POST', path: '/accounts', query: { per_page: 1 } })",
    "async () => cloudflare.request({ method: 'GET', path: '/accounts/other', query: { per_page: 1 } })",
    "async () => cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 }, body: {} })",
  ])
    assert.equal(exactReviewedCall("cloudflare", "execute", { code }, reviewed), false);
  assert.equal(
    exactReviewedCall(
      "cloudflare",
      "execute",
      { ...reviewed.cloudflare.execute, account_id: "other" },
      reviewed,
    ),
    false,
  );
  assert.equal(
    exactReviewedCall("cloudflare", "search", reviewed.cloudflare.execute, reviewed),
    false,
  );
  assert.equal(exactReviewedCall("posthog", "exec", reviewed.cloudflare.execute, reviewed), false);
  const posthog = { posthog: { exec: { command: "info dashboards-get-all" } } };
  assert.equal(
    exactReviewedCall("posthog", "exec", { command: "info dashboards-get-all" }, posthog),
    true,
  );
  assert.equal(
    exactReviewedCall("posthog", "exec", { command: "call dashboards-get-all {}" }, posthog),
    false,
  );
  const datadog = {
    datadog: {
      search_datadog_monitors: [
        { max_tokens: 100, telemetry: { intent: "Qualify native MCP read-only monitor search" } },
        { max_tokens: 1000, telemetry: { intent: "Qualify native MCP read-only monitor search" } },
        {
          max_tokens: 1000,
          query: "status:alert",
          telemetry: { intent: "Qualify native MCP read-only monitor search" },
        },
        {
          max_tokens: 1000,
          query: "status:alert priority:p1",
          telemetry: { intent: "Qualify native MCP read-only monitor search" },
        },
      ],
    },
  };
  assert.equal(
    exactReviewedCall(
      "datadog",
      "search_datadog_monitors",
      { max_tokens: 1000, telemetry: { intent: "Qualify native MCP read-only monitor search" } },
      datadog,
    ),
    true,
  );
  assert.equal(
    exactReviewedCall(
      "datadog",
      "search_datadog_monitors",
      {
        max_tokens: 1000,
        query: "status:alert",
        telemetry: { intent: "Qualify native MCP read-only monitor search" },
      },
      datadog,
    ),
    true,
  );
  for (const input of [
    { max_tokens: 1001, telemetry: { intent: "Qualify native MCP read-only monitor search" } },
    {
      max_tokens: 1000,
      query: "secret",
      telemetry: { intent: "Qualify native MCP read-only monitor search" },
    },
    { max_tokens: 1000, telemetry: { intent: "other" } },
    {
      max_tokens: 1000,
      query: "status:alert priority:p2",
      telemetry: { intent: "Qualify native MCP read-only monitor search" },
    },
  ])
    assert.equal(exactReviewedCall("datadog", "search_datadog_monitors", input, datadog), false);
  const approved = { posthog: { exec: { command: 'call dashboards-get-all {"limit":1}' } } };
  assert.equal(
    exactReviewedCall(
      "posthog",
      "exec",
      { command: 'call dashboards-get-all {"limit":1}' },
      approved,
    ),
    true,
  );
  for (const command of [
    'call dashboards-get-all {"limit":2}',
    "call dashboard-delete {}",
    'call dashboards-get-all {"limit":1,"offset":1}',
  ])
    assert.equal(exactReviewedCall("posthog", "exec", { command }, approved), false);
});

test("reviewed calls reject inherited server and tool names", () => {
  const reviewed = { cloudflare: { execute: { code: "approved" } } };
  for (const [server, tool] of [
    ["cloudflare", "constructor"],
    ["cloudflare", "toString"],
    ["__proto__", "toString"],
  ]) {
    assert.equal(exactReviewedCall(server, tool, {}, reviewed), false);
  }
  assert.equal(exactReviewedCall("cloudflare", "execute", { code: "approved" }, reviewed), true);
});

test("call evidence never serializes provider payloads or credentials", () => {
  const evidence = summarizeCall(
    "posthog",
    "list_projects",
    { content: [{ type: "text", text: "sensitive value" }], isError: false },
    7,
  );
  assert.deepEqual(evidence, {
    server: "posthog",
    tool: "list_projects",
    status: "ok",
    contentCount: 1,
    durationMs: 7,
  });
  assert.equal(JSON.stringify(evidence).includes("sensitive"), false);
});
