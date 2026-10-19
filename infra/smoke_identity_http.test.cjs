const assert = require("node:assert/strict");
const test = require("node:test");
const { smokeJson } = require("./smoke_identity_http.cjs");

async function invoke(replies, { budget = 60000, duration = 0, operation = "discovery" } = {}) {
  let now = 0;
  const calls = [],
    sleeps = [],
    logs = [];
  const result = await smokeJson(
    operation,
    "https://secret.invalid",
    {},
    {
      deadline: budget,
      now: () => now,
      sleep: async (delay) => {
        sleeps.push(delay);
        now += delay;
      },
      log: (line) => logs.push(line),
      fetch: async (url, options) => {
        calls.push({ url, options });
        now += duration;
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (reply instanceof Error) throw reply;
        const [status, body, headers = {}] = reply;
        return new Response(body, { status, headers });
      },
    },
  );
  assert(!logs.join("\n").includes("secret"));
  return { result, calls, sleeps, logs: logs.join("\n") };
}

test("known transport and HTTP transients recover, body stays under attempt signal", async () => {
  for (const reply of [
    [503, "secret"],
    [429, "secret", { "retry-after": "9" }],
    Object.assign(new Error("secret"), { cause: { code: "ECONNRESET" } }),
  ]) {
    const { result, calls, sleeps, logs } = await invoke([reply, [200, '{"ok":true}']]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(calls.length, 2);
    assert(calls.every(({ options }) => options.signal instanceof AbortSignal));
    assert.equal(sleeps.length, 1);
    assert.match(logs, /outcome=recovered/);
  }
});

test("unknown, credentials, permanent DNS, certificate, and JSON failures never retry", async () => {
  for (const reply of [
    [403, "secret"],
    [200, "secret malformed JSON"],
    new Error("secret"),
    ...["ENOTFOUND", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].map((code) =>
      Object.assign(new Error("secret"), { cause: { code } }),
    ),
  ]) {
    const { result, calls, sleeps } = await invoke([reply]);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test("negative assertions are returned, not retried; transient 4xx cannot prove rejection", async () => {
  for (const status of [401, 403]) {
    const { result, calls } = await invoke([[status, '{"error":"not_mintable"}']], {
      operation: "probe",
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, status);
    assert.equal(calls.length, 1);
  }
  for (const status of [408, 429]) {
    const { result, calls, logs } = await invoke([[status, "secret"]], { operation: "probe" });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 5);
    assert.match(logs, /outcome=exhausted/);
  }
});

test("five attempts and shared deadline bound fetch, body, and backoff", async () => {
  const exhausted = await invoke([[503, "secret"]]);
  assert.equal(exhausted.calls.length, 5);
  assert.deepEqual(exhausted.sleeps, [1000, 2000, 4000, 8000]);
  const deadline = await invoke([[429, "secret", { "retry-after": "60" }]]);
  assert.equal(deadline.calls.length, 1);
  assert.deepEqual(deadline.sleeps, []);
  assert.match(deadline.logs, /outcome=deadline/);
  const late = await invoke([[200, "{}"]], { budget: 2, duration: 3 });
  assert.equal(late.result.ok, false);
  const unknown = await invoke([[200, "{}"]], { operation: "secret" });
  assert.equal(unknown.calls.length, 0);
});

test("body failure uses its attempt signal and never retries invalid JSON", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const result = await smokeJson(
    "jwks",
    "https://secret.invalid",
    {},
    {
      now: () => 0,
      deadline: 60000,
      sleep: async () => {},
      log: () => {},
      signal: () => controller.signal,
      fetch: async (_url, { signal }) => ({
        status: 200,
        headers: new Headers(),
        text: async () => {
          attempts++;
          assert.equal(signal, controller.signal);
          controller.abort();
          throw new DOMException("secret", "AbortError");
        },
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(attempts, 5);
});

test("verifier failures identify static assertions without disclosing claims", () => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { generateKeyPairSync, sign } = require("node:crypto");
  const source = readFileSync(join(__dirname, "smoke-workload-identity.sh"), "utf8");
  const program = source.match(/<<'VERIFY_JS'\n([\s\S]*?)\nVERIFY_JS/)[1];
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key" };
  const issuer = "https://issuer.invalid",
    audience = "audience";
  const now = Math.floor(Date.now() / 1000);
  const original = {
    iss: issuer,
    aud: audience,
    token_use: "exchanged",
    iat: now,
    exp: now + 300,
    sub: "orb",
    orb_id: "orb",
    project_id: "project",
    host_incarnation: "1",
    jti: "id",
  };
  const directory = mkdtempSync(join(tmpdir(), "smoke-verifier-"));
  try {
    writeFileSync(join(directory, "verify.cjs"), program);
    writeFileSync(
      join(directory, "smoke_identity_http.cjs"),
      `module.exports.smokeJson = async (operation) => ({ok:true, body:operation === "discovery" ? {issuer:${JSON.stringify(issuer)}, jwks_uri:${JSON.stringify(`${issuer}/jwks`)}, id_token_signing_alg_values_supported:["RS256"]} : {keys:[${JSON.stringify(jwk)}]}});`,
    );
    for (const [field, label] of [
      ["iss", "issuer_mismatch"],
      ["aud", "audience_mismatch"],
      ["sub", "subject_mismatch"],
      ["orb_id", "orb_mismatch"],
      ["project_id", "project_mismatch"],
      ["host_incarnation", "incarnation_mismatch"],
    ]) {
      const claims = { ...original, [field]: "secret-value" };
      const input = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
      const result = spawnSync(
        process.execPath,
        [join(directory, "verify.cjs"), issuer, audience, "project", "orb", "1"],
        { input: jwt, encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(label));
      assert(!result.stderr.includes("secret-value"));
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal response headers dominate failed body reads", async () => {
  for (const operation of ["probe", "discovery"]) {
    for (const status of [400, 401, 403, 404, 422, 501]) {
      let calls = 0;
      const logs = [];
      const result = await smokeJson(
        operation,
        "https://secret.invalid",
        {},
        {
          now: () => 0,
          deadline: 60000,
          sleep: async () => {},
          log: (line) => logs.push(line),
          fetch: async () => {
            calls++;
            return {
              status,
              headers: new Headers(),
              text: async () => {
                throw Object.assign(new Error("secret"), { cause: { code: "ECONNRESET" } });
              },
            };
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(calls, 1, `${operation} HTTP ${status}`);
      assert(!logs.join("\n").includes("secret"));
    }
  }
});

test("typed terminal error bodies override transient HTTP statuses", async () => {
  for (const body of [
    '{"error":{"retryable":false}}',
    '{"error":{"status":"PERMISSION_DENIED","message":"secret"}}',
  ]) {
    const { result, calls, sleeps, logs } = await invoke([[503, body]]);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.match(logs, /outcome=terminal/);
  }
});
