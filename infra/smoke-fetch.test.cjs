const assert = require("node:assert/strict");
const test = require("node:test");
const { smokeFetch } = require("./smoke-fetch.cjs");

function harness(replies, deadline = 60_000) {
  let now = 0;
  const calls = [];
  const logs = [];
  const sleeps = [];
  return {
    calls,
    logs,
    sleeps,
    run: () =>
      smokeFetch(
        "https://invalid/secret-url",
        { headers: { authorization: "secret-token" } },
        deadline,
        {
          now: () => now,
          wall: () => 0,
          sleep: async (delay) => {
            sleeps.push(delay);
            now += delay;
          },
          log: (line) => logs.push(line),
          fetch: async (...args) => {
            const reply = replies[Math.min(calls.length, replies.length - 1)];
            calls.push(args);
            if (reply instanceof Error) throw reply;
            return new Response(reply.body || "{}", {
              status: reply.status,
              headers: reply.headers,
            });
          },
        },
      ),
  };
}
test("transient HTTP and transport recover with content-free diagnostics", async () => {
  for (const reply of [
    { status: 500, body: "secret-body", headers: { "content-type": "text/html" } },
    Object.assign(new TypeError("secret-error"), { cause: { code: "ECONNRESET" } }),
  ]) {
    const h = harness([reply, { status: 200, body: "[]" }]);
    assert.equal((await h.run()).value.status, 200);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.sleeps, [1000]);
    assert.match(h.logs.join("\n"), /outcome=recovered/);
    assert.doesNotMatch(h.logs.join("\n"), /secret/);
  }
});
test("explicit false, auth rejection and certificate errors are terminal", async () => {
  for (const reply of [
    { status: 500, body: '{"error":{"retryable":false}}' },
    { status: 500, body: '{"error":"internal"}' },
    { status: 403 },
    Object.assign(new TypeError("certificate"), { cause: { code: "CERT_HAS_EXPIRED" } }),
  ]) {
    const h = harness([reply]);
    const result = await h.run();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
    if (reply.status === 403) assert.equal(result.value.status, 403);
    else assert(result.error);
  }
});
test("rate limits cannot satisfy negative assertions; retries exhaust", async () => {
  const h = harness([{ status: 429 }]);
  assert.equal((await h.run()).error.kind, "exhausted");
  assert.equal(h.calls.length, 5);
});
test("Retry-After and deadline bound retries without resetting the budget", async () => {
  const h = harness([{ status: 503, headers: { "retry-after": "2" } }, { status: 200 }]);
  assert((await h.run()).value);
  assert.deepEqual(h.sleeps, [2000]);
  const expired = harness([{ status: 503, headers: { "retry-after": "60" } }], 10_000);
  assert.equal((await expired.run()).error.kind, "deadline");
  assert.equal(expired.calls.length, 1);
  assert.deepEqual(expired.sleeps, []);
});
test("late body cannot escape the same headers/body deadline", async () => {
  let now = 0;
  const result = await smokeFetch("https://invalid", {}, 1000, {
    now: () => now,
    wall: () => 0,
    log: () => {},
    fetch: async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => {
        now = 1001;
        return "{}";
      },
    }),
  });
  assert.equal(result.error.kind, "deadline");
});
test("body AbortError from the owned timeout is retryable", async () => {
  let calls = 0;
  let now = 0;
  const result = await smokeFetch("https://invalid", {}, 60_000, {
    now: () => now,
    wall: () => 0,
    timeoutSignal: () => ({ aborted: true, reason: { name: "TimeoutError" } }),
    sleep: async (delay) => {
      now += delay;
    },
    log: () => {},
    fetch: async () => {
      calls++;
      return {
        status: 200,
        headers: new Headers(),
        text: async () => {
          if (calls === 1) throw new DOMException("body interrupted", "AbortError");
          return "{}";
        },
      };
    },
  });
  assert.equal(result.value.status, 200);
  assert.equal(calls, 2);
});
test("mint protocol retryAfterMs is respected", async () => {
  const h = harness([
    { status: 429, body: '{"error":"rate_limited","retryAfterMs":2000}' },
    { status: 200 },
  ]);
  assert((await h.run()).value);
  assert.deepEqual(h.sleeps, [2000]);
});

test("wall deadline becomes a one-second monotonic budget regardless of clock origin", async () => {
  for (const origin of [100, 2_000_000]) {
    let now = origin;
    const timeouts = [];
    let calls = 0;
    const result = await smokeFetch("https://invalid", {}, 1_001_000, {
      now: () => now,
      wall: () => 1_000_000,
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return {};
      },
      log: () => {},
      fetch: async () => {
        calls++;
        now += 1001;
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(result.error.kind, "deadline");
    assert.equal(calls, 1);
    assert.deepEqual(timeouts, [1000]);
  }
});
test("redirects are manual and terminal even when the caller requests following", async () => {
  let calls = 0;
  const logs = [];
  const result = await smokeFetch("https://invalid/secret", { redirect: "follow" }, 60_000, {
    now: () => 0,
    wall: () => 0,
    log: (line) => logs.push(line),
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, "manual");
      return new Response("secret body", { status: 302, headers: { location: "https://secret" } });
    },
  });
  assert.deepEqual(result, { error: { kind: "terminal", status: 302 } });
  assert.equal(calls, 1);
  assert.match(logs.join("\n"), /outcome=terminal/);
  assert.doesNotMatch(logs.join("\n"), /secret/);
  const retryableRedirect = harness([{ status: 302, body: '{"error":{"retryable":true}}' }]);
  assert.deepEqual(await retryableRedirect.run(), { error: { kind: "terminal", status: 302 } });
  assert.equal(retryableRedirect.calls.length, 1);
  assert.deepEqual(retryableRedirect.sleeps, []);
});
test("retry telemetry records selected Retry-After and remaining budget", async () => {
  const h = harness([{ status: 503, headers: { "retry-after": "2" } }, { status: 200 }], 5000);
  assert((await h.run()).value);
  assert.match(h.logs[0], /delay_ms=2000 remaining_ms=5000/);
});
