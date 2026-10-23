import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (
  await readFile(new URL("./network-change-fanout-repro.mjs", import.meta.url), "utf8")
)
  .replace(
    'import { execFileSync } from "node:child_process";',
    "const { execFileSync } = globalThis.fixture;",
  )
  .replace('import http from "node:http";', "const { http } = globalThis.fixture;")
  .replace('import { chromium } from "playwright";', "const { chromium } = globalThis.fixture;");
assert.match(source, /^const \{ execFileSync \} = globalThis.fixture;$/m);
assert.match(source, /^const \{ http \} = globalThis.fixture;$/m);
assert.match(source, /^const \{ chromium \} = globalThis.fixture;$/m);
assert.doesNotMatch(
  source,
  /(?:from\s*|import\s*\()\s*["'](?:node:child_process|node:http|playwright)["']/,
);
for (const stage of ["invalid", "launch", "newPage", "close"]) {
  test(`manual reproducer owns cleanup at ${stage}`, () => {
    const script = `
      const calls = [];
      process.argv[2] = ${JSON.stringify(stage === "invalid" ? "typo" : "control")};
      globalThis.fixture = {
        execFileSync: (_cmd, args, options) => { calls.push(["docker", args, options.timeout]); return ""; },
        http: { createServer: () => ({
          once() {},
          listen: (_port, _host, done) => { calls.push(["listen"]); done(); },
          address: () => ({ port: 1234 }),
          closeAllConnections: () => calls.push(["connections-close"]),
          close: done => { calls.push(["server-close"]); done(); },
        }) },
        chromium: { launch: async () => {
          calls.push(["launch"]);
          if (${JSON.stringify(stage)} === "launch") throw Error("launch");
          return {
            newPage: async () => { throw Error("newPage"); },
            close: async () => { calls.push(["browser-close"]); if (${JSON.stringify(stage)} === "close") throw Error("close"); },
          };
        } },
      };
      if (typeof globalThis.fixture.execFileSync !== "function" || typeof globalThis.fixture.chromium.launch !== "function" || typeof globalThis.fixture.http.createServer !== "function") throw Error("missing probe fakes");
      try { await import(${JSON.stringify("data:text/javascript;base64," + Buffer.from(source).toString("base64"))}); }
      catch {}
      console.log(JSON.stringify(calls));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5000,
      env: {},
    });
    assert.equal(child.status, 0, child.stderr);
    const calls = JSON.parse(child.stdout);
    if (stage === "invalid") assert.deepEqual(calls, []);
    else {
      assert(calls.some(([name]) => name === "server-close"));
      assert(
        calls
          .filter(([name]) => name === "docker")
          .every(([, , timeout]) => timeout > 0 && timeout <= 30000),
      );
      if (stage !== "launch") assert(calls.some(([name]) => name === "browser-close"));
    }
  });
}
