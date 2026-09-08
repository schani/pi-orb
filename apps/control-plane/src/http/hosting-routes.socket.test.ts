import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { HOSTING_FILES_PATH } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishHostedFile } from "../domain/hosting.ts";
import type { HostingError } from "../domain/hosting-types.ts";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { createHostingAccessPolicy, registerHostingAccessGuard } from "./hosting-access.ts";
import { registerBrowserHostingRoutes, registerRuntimeHostingRoutes } from "./hosting-routes.ts";

const ORB = "00000000-0000-4000-8000-000000000071";
const TOKEN = "runtime-token";
const REQUEST = "00000000-0000-4000-8000-000000000091";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function responseComplete(raw: string): boolean {
  const boundary = raw.indexOf("\r\n\r\n");
  if (boundary < 0) return false;
  const length = /\r\ncontent-length: (\d+)/i.exec(raw)?.[1];
  return length !== undefined && raw.length - boundary - 4 >= Number(length);
}

function exchange(port: number, request: string, timeoutMs = 1_000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let raw = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(raw);
    };
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (responseComplete(raw)) finish();
    });
    socket.on("error", finish);
    socket.on("end", finish);
  });
}

function exchangeUntilClose(
  port: number,
  request: string,
  timeoutMs = 1_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let raw = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timeout);
      resolve(raw);
    };
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

const rawUpload = (headers: readonly string[], body = "") =>
  [
    `POST ${HOSTING_FILES_PATH}?path=index.html HTTP/1.1`,
    "Host: app.example.test",
    ...headers,
    "Connection: keep-alive",
    "",
    body,
  ].join("\r\n");

describe("hosting routes over a real HTTP socket", () => {
  const task = new NoSimulationTask("hosting socket routes", false);
  let app: ReturnType<typeof Fastify>;
  let harness: ReturnType<typeof makeHarness>;
  let port: number;
  let browserRequestTimeoutMs: number;
  let rawRequestAborted: Promise<void>;
  let markRawRequestAborted: () => void;

  beforeEach(async () => {
    browserRequestTimeoutMs = 200;
    rawRequestAborted = new Promise<void>((resolve) => {
      markRawRequestAborted = resolve;
    });
    harness = makeHarness({ hostingOrbId: ORB });
    harness.store.seedOrb(
      makeOrbRow(ORB, "project", "running", {
        runtimeTokenHash: hash(TOKEN),
        hostIncarnation: 1,
      }),
    );
    app = Fastify();
    app.addHook(
      "onRequest",
      (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction) => {
        request.raw.prependOnceListener("aborted", markRawRequestAborted);
        done();
      },
    );
    registerHostingAccessGuard(
      app,
      createHostingAccessPolicy({ filesOrigin: "https://files.example.test" })._unsafeUnwrap(),
      "https://app.example.test",
    );
    await registerRuntimeHostingRoutes(app, task, {
      store: harness.store,
      hosting: { ...harness.hosting.deps, maxFileBytes: MAX_FILE_BYTES },
      filesOrigin: "https://files.example.test",
      appOrigin: "https://app.example.test",
      requestTimeoutMs: 200,
    });
    registerBrowserHostingRoutes(app, task, {
      store: harness.store,
      hosting: harness.hosting.deps,
      filesOrigin: "https://files.example.test",
      appOrigin: "https://app.example.test",
      get requestTimeoutMs() {
        return browserRequestTimeoutMs;
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") return;
    port = address.port;
  });

  afterEach(async () => app.close());

  it.each([
    {
      name: "unauthorized",
      headers: ["Content-Type: text/plain", "Content-Length: 100"],
      status: 401,
      code: "unauthorized",
    },
    {
      name: "invalid metadata",
      headers: [
        "Authorization: Bearer runtime-token",
        "Content-Type: text/plain",
        "Content-Length: 100",
      ],
      status: 400,
      code: "invalid_request",
    },
    {
      name: "oversize",
      headers: [
        "Authorization: Bearer runtime-token",
        "Content-Type: text/plain",
        `Content-Length: ${MAX_FILE_BYTES + 1}`,
        `x-pi-orb-request-id: ${REQUEST}`,
        `x-pi-orb-sha256: ${hash("123456")}`,
      ],
      status: 413,
      code: "too_large",
    },
  ])(
    "answers $name before the client sends its declared body",
    async ({ headers, status, code }) => {
      const response = await exchange(port, rawUpload(headers), 500);
      expect(response).not.toBeNull();
      expect(response).toContain(`HTTP/1.1 ${status}`);
      expect(response).toContain(`"code":"${code}"`);
      expect(harness.hosting.ownedObjects()).toEqual([]);
    },
  );

  it("returns a published replay without reading the duplicate body or resetting the socket", async () => {
    const first = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?path=index.html`,
      headers: {
        host: "app.example.test",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/plain",
        "content-length": "5",
        "x-pi-orb-request-id": REQUEST,
        "x-pi-orb-sha256": hash("alpha"),
      },
      payload: "alpha",
    });
    expect(first.statusCode).toBe(201);
    const response = await exchange(
      port,
      rawUpload([
        `Authorization: Bearer ${TOKEN}`,
        "Content-Type: text/plain",
        "Content-Length: 5",
        `x-pi-orb-request-id: ${REQUEST}`,
        `x-pi-orb-sha256: ${hash("alpha")}`,
      ]),
      500,
    );
    expect(response).not.toBeNull();
    expect(response).toContain("HTTP/1.1 201");
    expect(response).toContain("index.html");
  });

  it("aborts a stalled upload at its deadline", async () => {
    const response = await exchange(
      port,
      rawUpload(
        [
          `Authorization: Bearer ${TOKEN}`,
          "Content-Type: text/plain",
          "Content-Length: 5",
          `x-pi-orb-request-id: ${REQUEST}`,
          `x-pi-orb-sha256: ${hash("alpha")}`,
        ],
        "a",
      ),
      500,
    );
    expect(response).not.toBeNull();
    expect(response).toContain("HTTP/1.1 503");
    expect(response).toContain('"code":"unavailable"');
    expect(harness.hosting.current("index.html")).toBeUndefined();
  });

  it("cancels the upload when the client disconnects", async () => {
    const socket: Socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      rawUpload(
        [
          `Authorization: Bearer ${TOKEN}`,
          "Content-Type: text/plain",
          "Content-Length: 5",
          `x-pi-orb-request-id: ${REQUEST}`,
          `x-pi-orb-sha256: ${hash("alpha")}`,
        ],
        "a",
      ),
    );
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.hosting.current("index.html")).toBeUndefined();
  });

  it("streams upload chunks into storage before request EOF without eager buffering", async () => {
    const bytes = harness.hosting.deps.bytes;
    const original = bytes.write.bind(bytes);
    let pulls = 0;
    Object.assign(bytes, {
      write: (...args: Parameters<typeof bytes.write>) => {
        const source = args[2];
        return original(
          args[0],
          args[1],
          {
            next: (
              task: Parameters<typeof source.next>[0],
              context: Parameters<typeof source.next>[1],
            ) => {
              pulls += 1;
              return source.next(task, context);
            },
            close: (task: Parameters<typeof source.close>[0]) => source.close(task),
          },
          args[3],
          args[4],
        );
      },
    });
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      rawUpload(
        [
          `Authorization: Bearer ${TOKEN}`,
          "Content-Type: text/plain",
          "Content-Length: 5",
          `x-pi-orb-request-id: ${REQUEST}`,
          `x-pi-orb-sha256: ${hash("alpha")}`,
        ],
        "a",
      ),
    );
    for (let attempts = 0; attempts < 20 && pulls === 0; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(pulls).toBeGreaterThan(0);
    expect(harness.hosting.current("index.html")).toBeUndefined();
    socket.write("lpha");
    await new Promise((resolve) => socket.once("data", resolve));
    socket.destroy();
  });

  it("never reports a clean complete download when integrity fails after the last bytes", async () => {
    const first = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?path=index.html`,
      headers: {
        host: "app.example.test",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/plain",
        "content-length": "5",
        "x-pi-orb-request-id": REQUEST,
        "x-pi-orb-sha256": hash("alpha"),
      },
      payload: "alpha",
    });
    expect(first.statusCode).toBe(201);
    const file = harness.hosting.current("index.html");
    expect(file).toBeDefined();
    if (file === undefined) return;
    let reads = 0;
    let closed = 0;
    Object.assign(harness.hosting.deps.bytes, {
      openExact: () =>
        okAsync({
          object: { ref: file.object, size: file.size, sha256: file.sha256 },
          source: {
            next: () => {
              reads += 1;
              return reads === 1
                ? okAsync(new TextEncoder().encode("alpha"))
                : errAsync({ type: "hosting_corruption" as const, message: "bad EOF" });
            },
            close: () => {
              closed += 1;
              return okAsync(undefined);
            },
          },
        }),
    });
    const response = await exchangeUntilClose(
      port,
      [
        `GET /s/${ORB}/index.html HTTP/1.1`,
        "Host: files.example.test",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      500,
    );
    expect(response).not.toBeNull();
    expect(response).toContain("HTTP/1.1 500");
    expect(response).toContain('"code":"internal"');
    expect(response?.split("\r\n\r\n")[1] ?? "").not.toBe("alpha");
    expect(closed).toBe(1);
  });

  it("aborts and closes a stalled download source at its deadline", async () => {
    const first = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?path=index.html`,
      headers: {
        host: "app.example.test",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/plain",
        "content-length": "5",
        "x-pi-orb-request-id": REQUEST,
        "x-pi-orb-sha256": hash("alpha"),
      },
      payload: "alpha",
    });
    expect(first.statusCode).toBe(201);
    const file = harness.hosting.current("index.html");
    if (file === undefined) return;
    let pulls = 0;
    let closed = 0;
    Object.assign(harness.hosting.deps.bytes, {
      openExact: () =>
        okAsync({
          object: { ref: file.object, size: file.size, sha256: file.sha256 },
          source: {
            next: (_task: unknown, context: { signal: AbortSignal }) => {
              pulls += 1;
              if (pulls === 1) return okAsync(new TextEncoder().encode("alpha"));
              return new ResultAsync<Uint8Array | null, HostingError>(
                new Promise((resolve) =>
                  context.signal.addEventListener(
                    "abort",
                    () =>
                      resolve(
                        err({ type: "hosting_cancelled" as const, message: "download cancelled" }),
                      ),
                    { once: true },
                  ),
                ),
              );
            },
            close: () => {
              closed += 1;
              return okAsync(undefined);
            },
          },
        }),
    });
    const response = await exchangeUntilClose(
      port,
      [
        `GET /s/${ORB}/index.html HTTP/1.1`,
        "Host: files.example.test",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      500,
    );
    expect(response).not.toBeNull();
    expect(response).toContain("HTTP/1.1 503");
    expect(response).toContain('"code":"unavailable"');
    expect(closed).toBe(1);
  });

  it("aborts a pending first download read when the client disconnects", async () => {
    browserRequestTimeoutMs = 20_000;
    const published = await publishHostedFile(
      task,
      harness.hosting.deps,
      {
        orbId: ORB,
        runtimeTokenHash: hash(TOKEN),
        incarnation: 1,
        requestId: "00000000-0000-4000-8000-000000000095",
        path: "pending.bin",
        size: 5,
        mediaType: "application/octet-stream",
        sha256: hash("alpha"),
      },
      {
        next: (() => {
          let sent = false;
          return () => {
            if (sent) return okAsync(null);
            sent = true;
            return okAsync(new TextEncoder().encode("alpha"));
          };
        })(),
        close: () => okAsync(undefined),
      },
      { signal: new AbortController().signal },
    );
    expect(published.isOk()).toBe(true);
    if (published.isErr()) return;

    let firstReadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const events: string[] = [];
    void rawRequestAborted.then(() => events.push("aborted"));
    let markSourceClosed!: () => void;
    const sourceClosed = new Promise<void>((resolve) => {
      markSourceClosed = resolve;
    });
    Object.assign(harness.hosting.deps.bytes, {
      openExact: () =>
        okAsync({
          object: {
            ref: published.value.object,
            size: published.value.size,
            sha256: published.value.sha256,
          },
          source: {
            next: (_task: unknown, context: { signal: AbortSignal }) => {
              firstReadStarted();
              return new ResultAsync<Uint8Array | null, HostingError>(
                new Promise((resolve) =>
                  context.signal.addEventListener(
                    "abort",
                    () =>
                      resolve(
                        err({ type: "hosting_cancelled" as const, message: "download cancelled" }),
                      ),
                    { once: true },
                  ),
                ),
              );
            },
            close: () => {
              events.push("closed");
              markSourceClosed();
              return okAsync(undefined);
            },
          },
        }),
    });
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      [`GET /s/${ORB}/pending.bin HTTP/1.1`, "Host: files.example.test", "", ""].join("\r\n"),
    );
    await started;
    socket.destroy();
    await rawRequestAborted;
    await sourceClosed;
    expect(events).toEqual(["aborted", "closed"]);
  });

  it("bounds download read-ahead behind a paused socket and closes on disconnect", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const chunks = 128;
    const digest = createHash("sha256");
    for (let index = 0; index < chunks; index += 1) digest.update(chunk);
    let uploadIndex = 0;
    const published = await publishHostedFile(
      task,
      { ...harness.hosting.deps, maxFileBytes: MAX_FILE_BYTES },
      {
        orbId: ORB,
        runtimeTokenHash: hash(TOKEN),
        incarnation: 1,
        requestId: "00000000-0000-4000-8000-000000000094",
        path: "large.bin",
        size: chunk.byteLength * chunks,
        mediaType: "application/octet-stream",
        sha256: digest.digest("hex"),
      },
      {
        next: () => okAsync(uploadIndex++ < chunks ? chunk : null),
        close: () => okAsync(undefined),
      },
      { signal: new AbortController().signal },
    );
    expect(published.isOk()).toBe(true);
    if (published.isErr()) return;

    let pulls = 0;
    let closed = 0;
    Object.assign(harness.hosting.deps.bytes, {
      openExact: () =>
        okAsync({
          object: {
            ref: published.value.object,
            size: published.value.size,
            sha256: published.value.sha256,
          },
          source: {
            next: () => {
              pulls += 1;
              return okAsync(pulls <= chunks ? chunk : null);
            },
            close: () => {
              closed += 1;
              return okAsync(undefined);
            },
          },
        }),
    });
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      [`GET /s/${ORB}/large.bin HTTP/1.1`, "Host: files.example.test", "", ""].join("\r\n"),
    );
    socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulls).toBeGreaterThan(1);
    expect(pulls).toBeLessThan(chunks);
    const pullsBeforeFirstRead = pulls;
    const received = new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.resume();
    await received;
    expect(pullsBeforeFirstRead).toBeLessThan(chunks);
    socket.destroy();
    for (let attempts = 0; attempts < 20 && closed === 0; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(closed).toBe(1);
  });

  it("streams the generation resolved before a concurrent replacement", async () => {
    const publish = (requestId: string, body: string) =>
      publishHostedFile(
        task,
        harness.hosting.deps,
        {
          orbId: ORB,
          runtimeTokenHash: hash(TOKEN),
          incarnation: 1,
          requestId,
          path: "snapshot.txt",
          size: body.length,
          mediaType: "text/plain",
          sha256: hash(body),
        },
        {
          next: (() => {
            let sent = false;
            return () => {
              if (sent) return okAsync(null);
              sent = true;
              return okAsync(new TextEncoder().encode(body));
            };
          })(),
          close: () => okAsync(undefined),
        },
        { signal: new AbortController().signal },
      );
    expect((await publish("snapshot-old", "alpha")).isOk()).toBe(true);
    const originalResolve = harness.hosting.deps.store.resolveFile.bind(harness.hosting.deps.store);
    let replace = true;
    Object.assign(harness.hosting.deps.store, {
      resolveFile: (...args: Parameters<typeof originalResolve>) =>
        originalResolve(...args).andThen((file) => {
          if (!replace) return okAsync(file);
          replace = false;
          return publish("snapshot-new", "bravo").map(() => file);
        }),
    });
    const response = await exchange(
      port,
      [
        `GET /s/${ORB}/snapshot.txt HTTP/1.1`,
        "Host: files.example.test",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    expect(response?.split("\r\n\r\n")[1]).toBe("alpha");
    expect(harness.hosting.current("snapshot.txt")?.sha256).toBe(hash("bravo"));
  });

  it("does not eagerly drain an upload while storage is blocked", async () => {
    Object.assign(harness.hosting.deps.bytes, {
      write: (
        _task: unknown,
        _session: unknown,
        _source: unknown,
        _expected: unknown,
        context: { signal: AbortSignal },
      ) =>
        new ResultAsync<never, HostingError>(
          new Promise((resolve) =>
            context.signal.addEventListener(
              "abort",
              () =>
                resolve(err({ type: "hosting_cancelled" as const, message: "storage cancelled" })),
              { once: true },
            ),
          ),
        ),
    });
    const total = 8 * 1024 * 1024;
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      rawUpload([
        `Authorization: Bearer ${TOKEN}`,
        "Content-Type: application/octet-stream",
        `Content-Length: ${total}`,
        `x-pi-orb-request-id: 00000000-0000-4000-8000-000000000095`,
        `x-pi-orb-sha256: ${"a".repeat(64)}`,
      ]),
    );
    let written = 0;
    const data = Buffer.alloc(64 * 1024);
    while (written < total && socket.write(data)) written += data.byteLength;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toBeLessThan(total);
    socket.destroy();
  });
});
