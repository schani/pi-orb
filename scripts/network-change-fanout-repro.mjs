#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { chromium } from "playwright";

// Usage: node scripts/network-change-fanout-repro.mjs <mode>
// Modes: control, docker-network-create-held, docker-start-held,
// docker-stop-held, docker-start-after. Requires Docker, Chromium, and the
// pi-orb-runtime:dev image. This diagnostic is not part of an automated suite.
const mode = process.argv[2] ?? "control";
const owner = `porb-fanout-${process.pid}-${randomUUID().slice(0, 8)}`;
const network = `${owner}-network`;
const container = `${owner}-container`;
const moduleCount = 64;
const heldConnectionCount = 6;
const settleMs = 2500;
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const inspect = (kind, name) => {
  try {
    docker(kind, "inspect", name);
    return true;
  } catch {
    return false;
  }
};
const cleanup = () => {
  if (inspect("container", container)) docker("rm", "-f", container);
  if (inspect("network", network)) docker("network", "rm", network);
};
const waitUntil = async (predicate, label, timeout = 5000) => {
  const deadline = now() + timeout;
  while (!predicate()) {
    if (now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(10);
  }
};

async function run() {
  if (mode !== "docker-network-create-held") docker("network", "create", network);
  if (["docker-start-held", "docker-stop-held", "docker-start-after", "control"].includes(mode)) {
    docker(
      "create",
      "--name",
      container,
      "--network",
      network,
      "--entrypoint",
      "/bin/sh",
      "pi-orb-runtime:dev",
      "-c",
      "sleep 300",
    );
  }
  if (mode === "docker-stop-held") docker("start", container);

  const timeline = [];
  const heldResponses = [];
  let entered = 0;
  let browserModulesRequested = 0;
  const failures = [];
  const entryImports = Array.from(
    { length: moduleCount },
    (_, index) => `import "/module-${index}.js";`,
  ).join("\n");
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(
        '<!doctype html><div id="root"></div><script type="module" src="/entry.js"></script>',
      );
      return;
    }
    if (request.url === "/entry.js") {
      response.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      response.end(
        `${entryImports}\ndocument.querySelector("#root").append(document.createElement("span"));`,
      );
      return;
    }
    if (request.url !== undefined && /^\/module-\d+\.js$/.test(request.url)) {
      entered += 1;
      if (entered <= heldConnectionCount) {
        timeline.push({ at: now(), event: "module-entered-held", ordinal: entered });
        heldResponses.push(() => {
          if (!response.writableEnded && !response.destroyed) {
            response.writeHead(200, {
              "content-type": "text/javascript",
              "cache-control": "no-store",
            });
            response.end(`export const value = ${entered};`);
          }
        });
      } else {
        response.writeHead(200, {
          "content-type": "text/javascript",
          "cache-control": "no-store",
        });
        response.end("export const value = true;");
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("request", (request) => {
    if (/\/module-\d+\.js$/.test(new URL(request.url()).pathname)) browserModulesRequested += 1;
  });
  page.on("requestfailed", (request) => {
    failures.push({ error: request.failure()?.errorText });
  });
  const navigation = page
    .goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load", timeout: 15_000 })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: error.message.split("\n")[0] }),
    );

  await waitUntil(() => entered === heldConnectionCount, "six server-entered module requests");
  await waitUntil(() => browserModulesRequested === moduleCount, "64 browser module requests");
  timeline.push({ at: now(), event: "gate-satisfied", entered, browserModulesRequested });

  if (mode === "control") {
    timeline.push({ at: now(), event: "control-no-mutation" });
  } else if (mode === "docker-network-create-held") {
    timeline.push({ at: now(), event: "mutation-begin", operation: "docker network create" });
    docker("network", "create", network);
    timeline.push({ at: now(), event: "mutation-end" });
  } else if (mode === "docker-start-held") {
    timeline.push({ at: now(), event: "mutation-begin", operation: "docker start" });
    docker("start", container);
    timeline.push({ at: now(), event: "mutation-end" });
  } else if (mode === "docker-stop-held") {
    timeline.push({ at: now(), event: "mutation-begin", operation: "docker stop" });
    docker("stop", "--time", "0", container);
    timeline.push({ at: now(), event: "mutation-end" });
  } else if (mode !== "docker-start-after") {
    throw new Error(`unknown mode: ${mode}`);
  }

  if (mode === "docker-start-after") {
    heldResponses.forEach((release) => {
      release();
    });
    await page.waitForSelector("#root > span", { state: "attached", timeout: 5000 });
    timeline.push({ at: now(), event: "all-modules-finished-root-mounted" });
    docker("start", container);
    await sleep(settleMs);
  } else {
    await sleep(settleMs);
    timeline.push({
      at: now(),
      event: "releasing-six-held-responses",
      failuresBeforeRelease: failures.length,
      serverEntriesBeforeRelease: entered,
    });
    heldResponses.forEach((release) => {
      release();
    });
  }

  const nav = await navigation;
  await sleep(250);
  const state = await page.evaluate(() => ({
    readyState: document.readyState,
    rootChildren: document.querySelector("#root")?.childElementCount ?? null,
  }));
  const failureErrors = Object.fromEntries(
    [...new Set(failures.map((failure) => failure.error))].map((error) => [
      error,
      failures.filter((failure) => failure.error === error).length,
    ]),
  );
  console.log(
    JSON.stringify({
      mode,
      gate: { heldConnectionCount, moduleCount },
      nav,
      state,
      browserModulesRequested,
      serverModuleEntries: entered,
      failureErrors,
      timeline,
    }),
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

try {
  await run();
} finally {
  cleanup();
}
