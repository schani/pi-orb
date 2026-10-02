import assert from "node:assert/strict";
import { test } from "node:test";
import { observeTokenResponses } from "./oauth-scope-measurement.mjs";

const endpoint = "https://consent.example/token";
const token = {
  access_token: "PRIVATE_ACCESS",
  refresh_token: "PRIVATE_REFRESH",
  token_type: "Bearer",
  expires_in: 60,
};
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const configured = (fetcher, options = {}) => {
  const result = observeTokenResponses(fetcher, {
    tokenEndpoint: endpoint,
    knownScopes: ["mcp_all"],
    record() {},
    ...options,
  });
  assert.equal(result.isOk(), true);
  return result.value;
};
const request = (kind) => [
  endpoint,
  {
    method: "POST",
    body: new URLSearchParams({ grant_type: kind, refresh_token: "PRIVATE_REFRESH" }).toString(),
  },
];

test("observes actual response scope on exchange/refresh without altering SDK response or adding requests", async () => {
  let calls = 0;
  const recorded = [];
  const fetcher = configured(
    async () => {
      calls++;
      return json({ ...token, scope: "mcp_all unknown:private" });
    },
    {
      tokenEndpoint: endpoint,
      knownScopes: ["mcp_all"],
      record: (metric) => recorded.push(metric),
    },
  );
  for (const kind of ["authorization_code", "refresh_token"]) {
    const response = await fetcher(...request(kind));
    assert.deepEqual(await response.json(), { ...token, scope: "mcp_all unknown:private" });
  }
  assert.equal(calls, 2);
  assert.deepEqual(recorded, [
    { kind: "authorization_code", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 1 },
    { kind: "refresh_token", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(recorded), /PRIVATE|unknown:private/);
});

test("observes scopes in actual-shaped large exchange and refresh responses without recording tokens", async () => {
  const largeToken = {
    ...token,
    access_token: `PRIVATE_ACCESS_${"a".repeat(12 * 1024)}`,
    refresh_token: `PRIVATE_REFRESH_${"r".repeat(12 * 1024)}`,
    scope: "mcp_all",
  };
  const recorded = [];
  const fetcher = configured(async () => json(largeToken), {
    record: (metric) => recorded.push(metric),
  });
  for (const kind of ["authorization_code", "refresh_token"]) {
    const response = await fetcher(...request(kind));
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), largeToken);
  }
  assert.deepEqual(recorded, [
    { kind: "authorization_code", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 0 },
    { kind: "refresh_token", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(recorded), /PRIVATE_ACCESS|PRIVATE_REFRESH|a{100}|r{100}/);
});

test("long RFC-valid scope lists remain measurable without disclosing unknown tokens", async () => {
  const recorded = [];
  const privateSentinel = `PRIVATE_SENTINEL_${"x".repeat(3000)}`;
  const unknowns = Array.from({ length: 2100 }, (_, i) => `unknown_${i}`);
  const scope = ["mcp_all", privateSentinel, ...unknowns].join(" ");
  const payload = {
    ...token,
    access_token: `PRIVATE_ACCESS_${"a".repeat(8 * 1024)}`,
    refresh_token: `PRIVATE_REFRESH_${"r".repeat(8 * 1024)}`,
    scope,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 64 * 1024);
  const fetcher = configured(async () => json(payload), {
    record: (metric) => recorded.push(metric),
  });
  for (const kind of ["authorization_code", "refresh_token"]) {
    const response = await fetcher(...request(kind));
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), payload);
  }
  assert.deepEqual(recorded, [
    {
      kind: "authorization_code",
      outcome: "present",
      knownScopes: ["mcp_all"],
      unknownCount: 2101,
    },
    { kind: "refresh_token", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 2101 },
  ]);
  assert.doesNotMatch(
    JSON.stringify(recorded),
    /PRIVATE|SENTINEL|unknown_2099|x{100}|a{100}|r{100}/,
  );
});

test("RFC 6749 scope tokens accept printable specials but never reveal unknown tokens", async () => {
  const records = [];
  const scope = "mcp_all !#$%&'()+,;=?@[]^_`{|}~ unknown!value";
  const fetcher = configured(async () => json({ ...token, scope }), {
    record: (metric) => records.push(metric),
  });
  assert.equal((await (await fetcher(...request("refresh_token"))).json()).scope, scope);
  assert.deepEqual(records, [
    { kind: "refresh_token", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /unknown!value|PRIVATE|\[\]/);
});

test("invalid scope shape has only fixed reasons and boolean diagnostics", async () => {
  const records = [];
  const values = [
    [null, "non_string", false, false, false],
    [42, "non_string", false, false, false],
    ["", "empty", false, false, false],
    ["mcp_all ", "invalid_syntax", true, false, false],
    [" mcp_all", "invalid_syntax", true, false, false],
    ["mcp_all  other", "invalid_syntax", false, false, false],
    ["mcp_all\tOTHER_PRIVATE", "invalid_syntax", false, true, true],
    ['mcp_all "PRIVATE"', "invalid_syntax", false, false, true],
  ];
  const fetcher = configured(async () => json({ ...token, scope: values[records.length][0] }), {
    record: (metric) => records.push(metric),
  });
  for (const [scope] of values) {
    const response = await fetcher(...request("refresh_token"));
    assert.deepEqual(await response.json(), { ...token, scope });
  }
  assert.deepEqual(
    records,
    values.map(
      ([, invalidReason, boundaryWhitespace, nonSpaceWhitespace, disallowedCharacter]) => ({
        kind: "refresh_token",
        outcome: "invalid",
        invalidReason,
        boundaryWhitespace,
        nonSpaceWhitespace,
        disallowedCharacter,
      }),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(records),
    /PRIVATE|OTHER|access_token|scope|refresh_token_value/,
  );
});

test("omitted/invalid scope and error responses are unverified, not inferred from discovery", async () => {
  const recorded = [];
  const responses = [
    json(token),
    json({ ...token, scope: 1 }),
    new Response('{"error":"invalid_grant"}', { status: 400 }),
    json({ ...token, scope: "" }),
  ];
  const fetcher = configured(async () => responses.shift(), {
    tokenEndpoint: endpoint,
    knownScopes: ["mcp_all"],
    record: (metric) => recorded.push(metric),
  });
  for (let i = 0; i < 4; i++) await fetcher(...request("refresh_token"));
  assert.deepEqual(recorded, [
    { kind: "refresh_token", outcome: "omitted" },
    {
      kind: "refresh_token",
      outcome: "invalid",
      invalidReason: "non_string",
      boundaryWhitespace: false,
      nonSpaceWhitespace: false,
      disallowedCharacter: false,
    },
    { kind: "refresh_token", outcome: "http_error" },
    {
      kind: "refresh_token",
      outcome: "invalid",
      invalidReason: "empty",
      boundaryWhitespace: false,
      nonSpaceWhitespace: false,
      disallowedCharacter: false,
    },
  ]);
});

test("OAuth errors and unusable token shapes precede any granted scope evidence", async () => {
  const records = [];
  const bodies = [
    { ...token, error: "invalid_grant", scope: "mcp_all" },
    { ...token, access_token: "", scope: "mcp_all" },
    { ...token, token_type: "mac", scope: "mcp_all" },
    { ...token, expires_in: 0, scope: "mcp_all" },
    { ...token, expires_in: Infinity, scope: "mcp_all" },
  ];
  const fetcher = configured(async () => json(bodies.shift()), {
    record: (metric) => records.push(metric),
  });
  for (let i = 0; i < 5; i++) await fetcher(...request("refresh_token"));
  assert.deepEqual(
    records.map((metric) => metric.outcome),
    ["oauth_error", "invalid_response", "invalid_response", "invalid_response", "invalid_response"],
  );
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|invalid_grant|mcp_all/);
});

test("exact HTTPS endpoint, method and grant type guard precedes response inspection", async () => {
  const recorded = [];
  let calls = 0;
  const fetcher = configured(
    async () => {
      calls++;
      return json({ ...token, scope: "mcp_all" });
    },
    {
      tokenEndpoint: endpoint,
      knownScopes: ["mcp_all"],
      record: (metric) => recorded.push(metric),
    },
  );
  await fetcher("https://consent.example/token-other", request("refresh_token")[1]);
  await fetcher("http://consent.example/token", request("refresh_token")[1]);
  await fetcher(endpoint, { method: "GET" });
  await fetcher(endpoint, { method: "POST", body: "grant_type=client_credentials" });
  assert.equal(calls, 4);
  assert.deepEqual(recorded, []);
  for (const bad of [
    "http://consent.example/token",
    "not a url",
    "https://user:secret@consent.example/token",
  ]) {
    const outcome = observeTokenResponses(async () => json(token), {
      tokenEndpoint: bad,
      knownScopes: ["mcp_all"],
      record() {},
    });
    assert.equal(outcome.isErr(), true);
    assert.deepEqual(outcome.error, { type: "invalid_configuration" });
    assert.doesNotMatch(JSON.stringify(outcome.error), /secret|not a url/);
  }
});

test("stalled cloned body stops measuring without consuming original response", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const recorded = [];
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  const response = new Response(
    new ReadableStream({
      pull() {
        started();
      },
    }),
  );
  let calls = 0;
  const fetcher = configured(
    async () => {
      calls++;
      return response;
    },
    {
      tokenEndpoint: endpoint,
      knownScopes: ["mcp_all"],
      record: (metric) => recorded.push(metric),
    },
  );
  const pending = fetcher(...request("refresh_token"));
  await reading;
  controller.abort();
  assert.equal(await pending, response);
  assert.equal(calls, 1);
  assert.deepEqual(recorded, [{ kind: "refresh_token", outcome: "unverified" }]);
  assert.equal(response.bodyUsed, false);
  await response.body.cancel();
});

test("bounded clone, recorder failure and malformed response never replace OAuth outcome", async () => {
  const recorded = [];
  let calls = 0;
  const oversized = { ...token, scope: "mcp_all", filler: "" };
  oversized.filler = "S".repeat(64 * 1024 + 1 - Buffer.byteLength(JSON.stringify(oversized)));
  assert.equal(Buffer.byteLength(JSON.stringify(oversized)), 64 * 1024 + 1);
  const fetcher = configured(
    async () => {
      calls++;
      return json(oversized);
    },
    {
      tokenEndpoint: endpoint,
      knownScopes: ["mcp_all"],
      record: (metric) => {
        recorded.push(metric);
        throw new Error("logger down");
      },
    },
  );
  const response = await fetcher(...request("refresh_token"));
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), oversized);
  assert.equal(calls, 1);
  assert.deepEqual(recorded, [{ kind: "refresh_token", outcome: "oversize" }]);
  const maliciousScope = `PRIVATE_SCOPE_${"s".repeat(10_000)}\t`;
  const scopeRecords = [];
  const scopeFetcher = configured(async () => json({ ...token, scope: maliciousScope }), {
    record: (metric) => scopeRecords.push(metric),
  });
  const scopeResponse = await scopeFetcher(...request("refresh_token"));
  assert.equal(scopeResponse.bodyUsed, false);
  assert.equal((await scopeResponse.json()).scope, maliciousScope);
  assert.deepEqual(scopeRecords, [
    {
      kind: "refresh_token",
      outcome: "invalid",
      invalidReason: "invalid_syntax",
      boundaryWhitespace: false,
      nonSpaceWhitespace: true,
      disallowedCharacter: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(scopeRecords), /PRIVATE_SCOPE|s{100}|PRIVATE/);
  const failed = configured(
    async () => {
      throw new Error("original failure");
    },
    { tokenEndpoint: endpoint, knownScopes: ["mcp_all"], record() {} },
  );
  await assert.rejects(failed(...request("refresh_token")), /original failure/);
});
