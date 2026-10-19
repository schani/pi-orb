import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { start } from "./server.ts";

test("render endpoint is read-only JSON with exact Host/Origin/bearer and visible typed failures", async (t) => {
  const running = (await start({ port: 0 }))._unsafeUnwrap();
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;
  const headers = {
    Origin: base,
    Authorization: `Bearer ${running.token}`,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({ harness: "pi", role: "root", timeZone: null, drafts: [] });
  const call = (extra: Record<string, string> = {}, payload = body, method = "POST") =>
    fetch(base + "/api/render", {
      method,
      headers: { ...headers, ...extra },
      ...(method !== "GET" ? { body: payload } : {}),
    });
  assert.equal((await call({ Authorization: "" })).status, 401);
  // fetch rewrites Host; exercise the transport boundary with Node's HTTP client.
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = request(
      base + "/api/render",
      {
        method: "POST",
        headers: { ...headers, Host: "evil.example" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await call({ Origin: "https://evil.example" })).status, 403);
  const absent = await fetch(base + "/api/render", {
    method: "POST",
    headers: { Authorization: headers.Authorization, "Content-Type": "application/json" },
    body,
  });
  assert.equal(absent.status, 403);
  assert.equal((await call({ "Content-Type": "text/plain" })).status, 400);
  assert.equal((await call({}, "{")).status, 400);
  assert.equal((await call({}, body, "GET")).status, 404);
  const unsupported = await call(
    {},
    JSON.stringify({ harness: "claude", role: "root", timeZone: null, drafts: [] }),
  );
  assert.equal(unsupported.status, 422);
  const unsupportedBody = (await unsupported.json()) as { error: { code: string } };
  assert.equal(unsupportedBody.error.code, "unsupported");
  const result = await call();
  assert.equal(result.status, 200);
  const rendered = (await result.json()) as { text: string };
  assert.deepEqual(Object.keys(rendered), ["text"]);
  assert.match(rendered.text, /^<codemode>/);
  assert.match(rendered.text, /<orb-instructions>/);
  assert.doesNotMatch(rendered.text, /{{time_zone}}|{{parent_instructions}}/);
  const oversized = await call({}, " ".repeat(1_048_576 * 6 + 65_537));
  assert.equal(oversized.status, 413);
});
