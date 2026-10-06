import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import { configuration, redirectServer } from "./browser-redirect.mjs";

const origin = "https://pi-orb-issuer-1077475695242.us-central1.run.app";

test("browser redirect preserves destinations and refuses credential/API forwarding", async (t) => {
  const server = redirectServer(origin);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  async function read(path, method = "GET") {
    const pending = request({ host: "127.0.0.1", port, path, method });
    pending.end();
    const [response] = await once(pending, "response");
    response.resume();
    await once(response, "end");
    return response;
  }
  for (const path of [
    "/",
    "/orbs/missing?tab=terminal",
    "//external.example/path",
    "/projects/%2F?next=https%3A%2F%2Fexternal.example",
  ]) {
    const response = await read(path);
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, origin + path);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal((await read("/orbs/missing", "HEAD")).headers.location, `${origin}/orbs/missing`);
  for (const path of [
    "/api/v1/system",
    "/api?query=x",
    "/auth/callback?code=private",
    "/.well-known/jwks.json",
  ]) {
    const response = await read(path);
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers.location, undefined);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await read("/orbs/missing", method);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.location, undefined);
  }
});

test("invalid redirect configuration fails closed", () => {
  for (const value of [
    undefined,
    "http://issuer.example",
    "https://issuer.example/path",
    "https://user:pass@issuer.example",
    "https://issuer.example\r\nLocation: https://external.example",
  ]) {
    assert.equal(configuration({ PI_ORB_REDIRECT_ORIGIN: value }).isErr(), true);
  }
  assert.equal(configuration({ PI_ORB_REDIRECT_ORIGIN: origin, PORT: "NaN" }).isErr(), true);
  assert.equal(configuration({ PI_ORB_REDIRECT_ORIGIN: origin }).isOk(), true);
});
