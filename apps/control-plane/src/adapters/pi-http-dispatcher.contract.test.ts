import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps Pi's dispatcher, fetch globals and compressed provider responses on its scoped Undici", () => {
  const root = join(import.meta.dirname, "../../../..");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { createRequire } from "node:module";
    import { gzipSync } from "node:zlib";
    const fromPi = createRequire(new URL("./node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
    const undici = fromPi("undici");
    const { configureHttpDispatcher } = await import(
      "./node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"
    );
    const server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(gzipSync(JSON.stringify({ provider: "ok" })));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const dispatchers = [];
    try {
      configureHttpDispatcher();
      dispatchers.push(undici.getGlobalDispatcher());
      assert.ok(dispatchers[0] instanceof undici.EnvHttpProxyAgent);
      assert.equal(globalThis.fetch, undici.fetch);
      assert.equal(globalThis.Response, undici.Response);
      const response = await fetch("http://127.0.0.1:" + server.address().port);
      assert.deepEqual(await response.json(), { provider: "ok" });
      await assert.rejects(fetch("http://127.0.0.1:" + server.address().port, {
        signal: AbortSignal.abort(),
      }), { name: "AbortError" });
      const customFetch = () => Promise.resolve(new Response("custom"));
      globalThis.fetch = customFetch;
      configureHttpDispatcher(30_000);
      dispatchers.push(undici.getGlobalDispatcher());
      assert.equal(globalThis.fetch, customFetch);
    } finally {
      await Promise.all(dispatchers.map(dispatcher => dispatcher.close()));
      await new Promise(resolve => server.close(resolve));
    }
  `,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        NO_PROXY: "*",
        no_proxy: "*",
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
