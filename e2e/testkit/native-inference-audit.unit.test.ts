import { channel } from "node:diagnostics_channel";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
// Test-owned JavaScript preload runs directly in Node, without a transpiler.
// @ts-expect-error JavaScript preload has no declaration file.
import { startAudit } from "./native-inference-audit.mjs";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const orb = "12345678-1234-4234-8234-123456789abc";
function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-audit-"));
  dirs.push(dir);
  const runtime = resolve("apps/orb-runtime/src/main.ts");
  const result = startAudit({
    env: {
      PI_ORB_ID: orb,
      PI_ORB_TEST_AUDIT_DIR: dir,
      PI_ORB_TEST_AUDIT_ENTRY: runtime,
      PI_ORB_TEST_AUDIT_ORIGIN: "https://fake-openai.flingit.run",
      PI_ORB_TEST_AUDIT_PATH: "/inference/codex/responses",
    },
    argv: [process.execPath, runtime],
    pid: 123,
    ...overrides,
  });
  if (result.isOk()) stops.push(result.value.stop);
  return { result, dir, file: join(dir, `${orb}-123.json`) };
}
const request = () => ({
  origin: "https://fake-openai.flingit.run",
  path: "/inference/codex/responses",
});
function publish(name: string, message: unknown) {
  channel(`undici:${name}`).publish(message);
}
it("observes native messages without replacing fetch or the dispatcher; joins only sendHeaders", () => {
  const fetchBefore = globalThis.fetch;
  const dispatcherBefore = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ];
  const { result, file } = setup();
  expect(result.isOk()).toBe(true);
  const req = request();
  const socket = {};
  publish("client:beforeConnect", {
    connectParams: { hostname: "fake-openai.flingit.run", protocol: "https:" },
  });
  publish("request:create", { request: req });
  publish("client:connected", {
    connectParams: { hostname: "fake-openai.flingit.run", protocol: "https:" },
    socket,
  });
  publish("client:sendHeaders", { request: req, socket });
  publish("request:headers", { request: req, response: { statusCode: 200 } });
  const audit = JSON.parse(readFileSync(file, "utf8"));
  expect(audit.events.map((e: { event: string }) => e.event)).toEqual([
    "before_connect",
    "request_create",
    "connected",
    "send_headers",
    "headers",
  ]);
  expect(audit.events[0].request).toBeNull();
  expect(audit.events[3]).toMatchObject({ request: 1, socket: 1 });
  expect(globalThis.fetch).toBe(fetchBefore);
  expect((globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")]).toBe(
    dispatcherBefore,
  );
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(audit)).not.toMatch(/flingit|inference|SECRET|authorization/);
});
it("excludes control plane, inherited Node tools, invalid identity and public directories", () => {
  for (const overrides of [
    { argv: [process.execPath, resolve("apps/control-plane/src/main.ts")] },
    { argv: [process.execPath, "/tmp/tool.mjs"] },
    { env: {} },
  ])
    expect(setup(overrides).result.isErr()).toBe(true);
});
it("filters exact origin and pathname without touching payloads or headers", () => {
  const { file } = setup();
  for (const req of [
    { ...request(), path: "/oauth" },
    { ...request(), origin: "http://fake-openai.flingit.run" },
    { ...request(), origin: "https://other.invalid" },
  ])
    publish("request:create", { request: req });
  const req = request();
  Object.defineProperty(req, "headers", {
    get() {
      throw new Error("SECRET");
    },
  });
  Object.defineProperty(req, "body", {
    get() {
      throw new Error("SECRET");
    },
  });
  publish("request:create", { request: req });
  expect(JSON.parse(readFileSync(file, "utf8")).events).toHaveLength(1);
});
it("bounds the tail and active coverage, contains callback errors and allowlists errors", () => {
  const { file } = setup();
  for (let i = 0; i < 100; i++) publish("request:create", { request: request() });
  const req = request();
  publish("request:create", { request: req });
  publish("request:error", {
    request: req,
    error: { code: "SECRET", cause: { code: "ENOTFOUND", message: "SECRET" } },
  });
  expect(() =>
    publish("request:create", {
      get request() {
        throw new Error("SECRET");
      },
    }),
  ).not.toThrow();
  const audit = JSON.parse(readFileSync(file, "utf8"));
  expect(audit.events).toHaveLength(64);
  expect(audit.droppedCount).toBe(38);
  expect(audit.activeRequests.length).toBeLessThanOrEqual(64);
  expect(audit.activeDroppedCount).toBeGreaterThan(0);
  expect(audit.callbackErrorCount).toBe(1);
  expect(audit.events.at(-1).error).toBe("ENOTFOUND");
  expect(JSON.stringify(audit)).not.toContain("SECRET");
});
