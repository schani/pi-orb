import { Readable } from "node:stream";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { readOrbFile } from "../domain/orb-files.ts";
import { makeHarness, seedRunningOrb, TEST_USER_ID } from "../testkit/fixtures.ts";
import {
  filePath,
  registerOrbFilesBoundary,
  registerOrbFilesGateway,
} from "./orb-files-gateway.ts";
import { createPreviewHosts } from "./preview-host.ts";
import { registerResponseDrain } from "./response-drain.ts";

const orbId = "12345678-1234-4234-8234-123456789abc";
async function setup() {
  const task = new NoSimulationTask("files gateway", false);
  const h = makeHarness();
  seedRunningOrb(task, h, orbId);
  const binding = vi.fn(() =>
    okAsync({ baseUrl: "http://private", token: "secret", incarnation: "0", cwd: "/" }),
  );
  const deps = {
    ...h.deps,
    hostProvider: { ...h.deps.hostProvider, kind: "docker", executionBinding: binding },
  };
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.net",
    appOrigin: "https://app.example.com",
    filesOrigin: "https://files.example.org",
  })._unsafeUnwrap();
  const host = new URL(hosts.files.url(orbId)._unsafeUnwrap()).host;
  const app = Fastify();
  registerResponseDrain(app, new AbortController().signal);
  registerOrbFilesBoundary(app, { hosts: hosts.files, appOrigin: "https://app.example.com" });
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "owner")
      request.previewIdentity = {
        principal: { kind: "user", user: { id: TEST_USER_ID, email: null } },
        expiresAt: task.wallNow() + 60000,
      };
  });
  const open = vi.fn<import("../domain/orb-files.ts").OrbFilesTransport["open"]>(() =>
    okAsync({
      contentType: "text/plain",
      length: 5,
      body: Readable.from(["hello"]),
    }),
  );
  registerOrbFilesGateway(app, task, {
    deps,
    hosts: hosts.files,
    appOrigin: "https://app.example.com",
    transport: { open },
  });
  const platform = vi.fn(() => "platform");
  app.all("/*", platform);
  return { app, task, h, deps, open, binding, platform, headers: { host, authorization: "owner" } };
}
it("decodes paths once, rejecting traversal, separators and malformed escapes", () => {
  expect(filePath("/Review%20notes%25%23%3F?secret")._unsafeUnwrap()).toBe("/Review notes%#?");
  expect(filePath("/%252e%252e")._unsafeUnwrap()).toBe("/%2e%2e");
  for (const path of [
    "/%2fetc",
    "/%5cetc",
    "/%00",
    "/%zz",
    "/../secret",
    "/%2e%2e/secret",
    "//etc",
  ])
    expect(filePath(path).isErr()).toBe(true);
});
it("dispatches all file-host paths before app routes, preserving private headers", async () => {
  const f = await setup();
  const logs = vi.spyOn(f.task, "log");
  const before = f.h.store.orbSnapshot(orbId);
  const starts = f.h.world.hostStartCountOf(orbId);
  for (const url of ["/api/v1/projects", "/runtime/private", "/Review%20notes"]) {
    const response = await f.app.inject({ url, headers: f.headers });
    expect(response.body).toBe("hello");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  }
  expect(f.open.mock.calls[2]?.[1]).toMatchObject({ method: "GET", path: "/Review notes" });
  expect(f.platform).not.toHaveBeenCalled();
  expect(f.h.store.orbSnapshot(orbId)).toEqual(before);
  expect(f.h.world.hostStartCountOf(orbId)).toBe(starts);
  expect(logs.mock.calls.filter((call) => String(call[0]).startsWith("lifecycle:"))).toHaveLength(
    0,
  );
  await f.app.close();
});
it("denies unauthenticated reads, writes, service workers, upgrades and reserved paths", async () => {
  const f = await setup();
  expect((await f.app.inject({ url: "/a", headers: { host: f.headers.host } })).statusCode).toBe(
    401,
  );
  for (const headers of [
    { "service-worker": "script" },
    { "sec-fetch-dest": "serviceworker" },
    { upgrade: "websocket" },
  ])
    expect(
      (await f.app.inject({ url: "/a", headers: { ...f.headers, ...headers } })).statusCode,
    ).toBe(403);
  expect((await f.app.inject({ method: "POST", url: "/a", headers: f.headers })).statusCode).toBe(
    405,
  );
  expect((await f.app.inject({ url: "/__pi_orb/other", headers: f.headers })).statusCode).toBe(403);
  expect(f.open).not.toHaveBeenCalled();
  await f.app.close();
});
it("preserves missing-file URLs and deduplicates failure/recovery without secrets", async () => {
  const f = await setup();
  const logs = vi.spyOn(f.task, "log");
  f.open.mockReturnValue(errAsync({ status: 404, message: "File doesn't exist" }));
  for (let i = 0; i < 2; i++) {
    const response = await f.app.inject({
      url: "/secret-path",
      headers: { ...f.headers, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain("https://app.example.com");
  }
  expect((await f.app.inject({ method: "HEAD", url: "/a", headers: f.headers })).statusCode).toBe(
    404,
  );
  f.open.mockReturnValue(
    okAsync({ contentType: "text/plain", length: 0, body: Readable.from([]) }),
  );
  await f.app.inject({ url: "/a", headers: f.headers });
  const events = logs.mock.calls.filter((call) => String(call[0]).startsWith("lifecycle:"));
  expect(events).toHaveLength(2);
  expect(JSON.stringify(events)).not.toMatch(/secret|private/);
  await f.app.close();
});
it("times out stalled DB admission without subsequent host I/O", async () => {
  const f = await setup();
  const timeout = new AbortController();
  vi.spyOn(f.task, "createDeadline").mockReturnValue({ signal: timeout.signal, cancel() {} });
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.h.store, "getOrb").mockImplementation(() => {
    timeout.abort();
    return ResultAsync.fromSafePromise(blocked).map(() => f.h.store.orbSnapshot(orbId));
  });
  const response = await f.app.inject({ url: "/a", headers: f.headers });
  expect(response.statusCode).toBe(503);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.binding).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
  await f.app.close();
});

it("checks owner, existence, running compute and current binding at admission", async () => {
  const f = await setup();
  const request = { orbId, ownerUserId: TEST_USER_ID, method: "GET" as const, path: "/a" };
  const read = (overrides = {}) =>
    readOrbFile(
      f.task,
      f.deps,
      { open: f.open },
      { ...request, ...overrides },
      new AbortController().signal,
    );
  expect((await read({ ownerUserId: "coworker" }))._unsafeUnwrapErr().status).toBe(403);
  expect((await read({ orbId: "missing" }))._unsafeUnwrapErr().status).toBe(404);
  expect(f.binding).not.toHaveBeenCalled();
  f.deps.hostProvider.kind = "process";
  expect((await read()).isOk()).toBe(true);
  expect(f.open).toHaveBeenCalledOnce();
  f.open.mockClear();
  f.deps.hostProvider.kind = "docker";
  f.binding.mockReturnValue(
    okAsync({ baseUrl: "http://private", token: "secret", incarnation: "1", cwd: "/" }),
  );
  expect((await read())._unsafeUnwrapErr().status).toBe(409);
  const row = f.h.store.orbSnapshot(orbId);
  if (!row) throw new Error("missing fixture");
  f.binding.mockImplementation(() => {
    f.h.store.seedOrb({ ...row, hostIncarnation: row.hostIncarnation + 1 });
    return okAsync({ baseUrl: "http://private", token: "secret", incarnation: "0", cwd: "/" });
  });
  expect((await read())._unsafeUnwrapErr().status).toBe(409);
  f.h.store.seedOrb(row);
  f.binding.mockImplementation(() => {
    f.h.store.seedOrb({ ...row, state: "stopping" });
    return okAsync({ baseUrl: "http://private", token: "secret", incarnation: "0", cwd: "/" });
  });
  expect((await read())._unsafeUnwrapErr().status).toBe(409);
  expect((await read())._unsafeUnwrapErr().status).toBe(503);
  expect(f.open).not.toHaveBeenCalled();
  await f.app.close();
});

it("cancels upstream transport through standard response draining", async () => {
  const f = await setup();
  let reading = () => {};
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const body = new Readable({ read: reading });
  let signal: AbortSignal | undefined;
  f.open.mockImplementation((_route, _request, upstreamSignal) => {
    signal = upstreamSignal;
    return okAsync({ contentType: "application/octet-stream", length: 6, body });
  });
  const download = f.app.inject({ url: "/big", headers: f.headers }).then(
    () => {},
    () => {},
  );
  await started;
  await f.app.close();
  await download;
  expect(signal?.aborted).toBe(true);
  expect(body.destroyed).toBe(true);
});
