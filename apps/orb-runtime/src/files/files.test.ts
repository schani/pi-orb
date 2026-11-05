import type { ReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrbAgent } from "../domain/orb-agent.ts";
import { buildExecutionServer } from "../execution/server.ts";
import { buildRuntimeServer } from "../http/server.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { openLiveFile } from "./filesystem.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
let dir: string;
const apps: FastifyInstance[] = [];
const headers = { authorization: "Bearer secret", "x-orb-incarnation": "7" };
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "live-files-")));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.mocked(fs.statfs).mockRestore();
  await fs.rm(dir, { recursive: true, force: true });
});

it("streams the opened descriptor to its fixed end, including empty files", async () => {
  for (const size of [0, 3 * 65536 + 17]) {
    const path = join(dir, "file");
    await fs.writeFile(path, Buffer.alloc(size, 42));
    const file = (await openLiveFile(path))._unsafeUnwrap();
    await fs.appendFile(path, "appended");
    await fs.rm(path);
    await fs.writeFile(path, "replacement");
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      expect(chunk.length).toBeLessThanOrEqual(65536);
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(size, 42));
    expect((await file.close()).isOk()).toBe(true);
  }
});

it("rejects invalid, absent, directory, pseudo and fs.symlink-component paths", async () => {
  await fs.writeFile(join(dir, "file"), "data");
  await fs.symlink(dir, join(dir, "parent"));
  await fs.symlink(join(dir, "file"), join(dir, "leaf"));
  for (const path of ["relative", "", "/nul\0byte"])
    expect((await openLiveFile(path))._unsafeUnwrapErr().status).toBe(400);
  for (const path of [
    "/proc/version",
    "/sys/kernel/uevent_seqnum",
    "/dev/null",
    "/dev/shm/file",
    "/tmp/../proc/version",
    dir,
    join(dir, "leaf"),
    join(dir, "parent/file"),
    `${dir}/parent/../file`,
  ]) {
    expect((await openLiveFile(path))._unsafeUnwrapErr().status).toBe(403);
  }
  expect((await openLiveFile(join(dir, "absent")))._unsafeUnwrapErr().status).toBe(404);
});

it("rejects special files without waiting on them", async () => {
  const server = createServer();
  const path = join(dir, "socket");
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    expect((await openLiveFile(path))._unsafeUnwrapErr().status).toBe(403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("checks proc/sys aliases using the opened descriptor filesystem, allowing tmpfs", async () => {
  const path = join(dir, "file");
  await fs.writeFile(path, "data");
  for (const type of [0x9fa0, 0x62656572, 0x01021994]) {
    vi.mocked(fs.statfs).mockResolvedValueOnce({ type } as Awaited<ReturnType<typeof fs.statfs>>);
    const result = await openLiveFile(path);
    if (type === 0x01021994) await result._unsafeUnwrap().close();
    else expect(result._unsafeUnwrapErr().status).toBe(403);
    if (process.platform === "linux")
      expect(fs.statfs).toHaveBeenLastCalledWith(expect.stringMatching(/^\/proc\/self\/fd\/\d+$/));
  }
});

function appFor(harness: "pi" | "claude", ready = true) {
  const app =
    harness === "pi"
      ? buildExecutionServer({
          token: "secret",
          incarnation: "7",
          cwd: dir,
          ready: () => (ready ? { cwd: dir, incarnation: "7", pid: 1, checkoutCommit: "" } : null),
        })
      : buildRuntimeServer(
          { getHealth: () => ({ status: ready ? "ready" : "initializing" }) } as OrbAgent,
          { closeAll: () => undefined } as unknown as TerminalManager,
          "secret",
          undefined,
          "7",
        );
  apps.push(app);
  return app;
}
for (const harness of ["pi", "claude"] as const) {
  it(`${harness}: authenticates GET/HEAD before reading, with typed errors`, async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const app = appFor(harness);
      for (const [override, status] of [
        [{ authorization: "" }, 401],
        [{ authorization: "secret" }, 401],
        [{ authorization: "Bearer secreT" }, 401],
        [{ authorization: "Bearer secret extra" }, 401],
        [{ "x-orb-incarnation": "6" }, 409],
      ] as const) {
        const response = await app.inject({
          method,
          url: "/v1/files",
          headers: { ...headers, ...override },
        });
        expect(response.statusCode).toBe(status);
      }
      expect(
        (await appFor(harness, false).inject({ method, url: "/v1/files", headers })).statusCode,
      ).toBe(503);
    }
    const app = appFor(harness);
    for (const [query, status] of [
      ["", 400],
      ["?path=relative", 400],
      ["?path=/a&path=/b", 400],
      [`?path=${encodeURIComponent(dir)}`, 403],
      [`?path=${encodeURIComponent(join(dir, "absent"))}`, 404],
    ] as const) {
      const response = await app.inject({ url: `/v1/files${query}`, headers });
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toMatchObject({
        status,
        message: expect.any(String),
      });
    }
  });
  it(`${harness}: serves encoded files, asset MIME and HEAD metadata`, async () => {
    const app = appFor(harness);
    for (const [extension, mime] of [
      ["html", "text/html"],
      ["css", "text/css"],
      ["js", "application/javascript"],
      ["mjs", "application/javascript"],
      ["ts", "text/plain"],
      ["png", "image/png"],
      ["__proto__", "application/octet-stream"],
    ] as const) {
      const path = join(dir, `Review # %.${extension}`);
      await fs.writeFile(path, "data");
      for (const method of ["GET", "HEAD"] as const) {
        const response = await app.inject({
          method,
          url: `/v1/files?path=${encodeURIComponent(path)}`,
          headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers).toMatchObject({
          "content-type": expect.stringContaining(mime),
          "content-length": "4",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        expect(response.body).toBe(method === "GET" ? "data" : "");
      }
    }
  });
}
it.each(["truncation", "cancellation"] as const)(
  "closes streams on %s without claiming a complete response",
  async (mode) => {
    const path = join(dir, "file");
    await fs.writeFile(path, "data");
    if (mode === "cancellation") await fs.truncate(path, 64 * 1024 * 1024);
    const app = appFor("pi");
    let source!: ReadStream;
    let onClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      onClose = resolve;
    });
    app.addHook("onSend", async (_request, _reply, payload) => {
      source = payload as ReadStream;
      source.once("close", onClose);
      if (mode === "truncation") await fs.truncate(path, 2);
      return payload;
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      `${app.listeningOrigin}/v1/files?path=${encodeURIComponent(path)}`,
      { headers },
    );
    expect(response.headers.get("content-length")).toBe(
      mode === "truncation" ? "4" : String(64 * 1024 * 1024),
    );
    if (mode === "truncation") await expect(response.arrayBuffer()).rejects.toThrow();
    else {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("response body missing");
      await reader.read();
      await reader.cancel();
    }
    await closed;
    expect(source.closed).toBe(true);
    expect(source.bytesRead).toBeLessThan(mode === "truncation" ? 4 : 64 * 1024 * 1024);
  },
);
