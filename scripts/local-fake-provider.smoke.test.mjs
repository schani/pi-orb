import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

// Explicitly run under the owned wrapper, never against a deployed provider.
test("owned provider: manual approval, token exchange, zstd tool call and continuation", {
  skip: !process.env.PI_ORB_FAKE_OPENAI,
}, async () => {
  const origin = process.env.PI_ORB_FAKE_OPENAI;
  assert.match(origin, /^http:\/\/(127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3}):3210$/);
  const request = async (path, body, headers = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined
        ? {}
        : {
            body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(5000),
    });
    return response;
  };
  const scenario = {
    auth: { accountId: "acct_owned_smoke", device: { manualApprove: true } },
    model: {
      rules: [
        {
          match: { userMessage: "owned-smoke" },
          steps: [
            { type: "toolCall", name: "bash", arguments: { command: "printf owned-tool-ok" } },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { toolResultContains: { regex: "owned-tool-ok" } },
          steps: [
            { type: "text", content: "owned-continuation-ok" },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  };
  const created = await request("/api/__mock__/sessions", { name: "owned-smoke", scenario });
  assert.equal(created.status, 201);
  const session = await created.json();
  const key = session.sessionKey;
  try {
    assert.equal(new URL(session.oauthBaseUrl).origin, origin);
    assert.equal(new URL(session.inferenceBaseUrl).origin, origin);
    const client_id = "app_EMoamEEZ73f0CkXaXp7hrann";
    const usercode = await request(`/oai/${key}/api/accounts/deviceauth/usercode`, { client_id });
    assert.equal(usercode.status, 200);
    const device = await usercode.json();
    const pollBody = { device_auth_id: device.device_auth_id, user_code: device.user_code };
    const pending = await request(`/oai/${key}/api/accounts/deviceauth/token`, pollBody);
    assert.equal(pending.status, 403);
    assert.equal((await pending.json()).error.code, "deviceauth_authorization_pending");
    const approved = await request(`/api/__mock__/sessions/${key}/deviceauth/approve`, {
      user_code: device.user_code,
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { approved: true });
    const polled = await request(`/oai/${key}/api/accounts/deviceauth/token`, pollBody);
    assert.equal(polled.status, 200);
    const authorization = await polled.json();
    const exchanged = await request(
      `/oai/${key}/oauth/token`,
      new URLSearchParams({
        client_id,
        grant_type: "authorization_code",
        code: authorization.authorization_code,
        code_verifier: authorization.code_verifier,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    assert.equal(exchanged.status, 200);
    const token = await exchanged.json();
    assert.equal(typeof token.access_token, "string");
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      "chatgpt-account-id": "acct_owned_smoke",
      accept: "text/event-stream",
    };
    const modelPath = `/oai/${key}/backend-api/codex/responses`;
    const input = [{ role: "user", content: [{ type: "input_text", text: "owned-smoke" }] }];
    const first = await request(
      modelPath,
      zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt-5.4", input }))),
      { ...headers, "content-encoding": "zstd" },
    );
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type"), /text\/event-stream/);
    const events = (text) =>
      text
        .split("\n\n")
        .map((block) => block.replace(/^data: /, "").trim())
        .filter((line) => line && line !== "[DONE]")
        .map((line) => JSON.parse(line));
    const firstEvents = events(await first.text());
    const tool = firstEvents.find(
      (event) => event.type === "response.output_item.done" && event.item?.type === "function_call",
    ).item;
    assert.equal(tool.name, "bash");
    assert.equal(firstEvents.at(-1).type, "response.completed");
    const args = JSON.parse(tool.arguments);
    assert.equal(args.command, "printf owned-tool-ok");
    const output = execFileSync("bash", ["-c", args.command], { encoding: "utf8" });
    const second = await request(
      modelPath,
      {
        model: "gpt-5.4",
        input: [...input, { type: "function_call_output", call_id: tool.call_id, output }],
      },
      headers,
    );
    assert.equal(second.status, 200);
    const secondEvents = events(await second.text());
    assert.equal(
      secondEvents
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
      "owned-continuation-ok",
    );
    assert.equal(secondEvents.at(-1).type, "response.completed");
    const ledger = await request(`/api/__mock__/sessions/${key}/requests`);
    assert.equal(ledger.status, 200);
    const records = await ledger.json();
    assert.ok(JSON.stringify(records).includes("owned-tool-ok"));
  } finally {
    const deleted = await fetch(`${origin}/api/__mock__/sessions/${key}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deleted.status, 200);
  }
});
