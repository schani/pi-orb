import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_SUBPROTOCOL, type ServerFrame, TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { openControlPlaneDatabase } from "../apps/control-plane/src/adapters/database.ts";
import { SESSION_COOKIE_NAME } from "../apps/control-plane/src/domain/application-auth.ts";
import {
  type ControlPlaneHandle,
  controlPlaneRequest,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  startControlPlane,
  waitFor,
} from "./harness.ts";

const appOrigin = "https://app.full-main.test";
const filesOrigin = "https://files.full-main.test";
let cp: ControlPlaneHandle | undefined;
let fake: FakeSession | undefined;
let nameFake: FakeSession | undefined;
let directory = "";
let broker: ReturnType<typeof createServer> | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (cp) {
    mkdirSync(".context/consolidation/full-main", { recursive: true });
    writeFileSync(
      `.context/consolidation/full-main/control-plane-${Date.now()}.log`,
      cp.logs.join(""),
    );
    await cp.stop();
  }
  if (broker)
    await new Promise<void>((resolve, reject) =>
      broker?.close((error) => (error ? reject(error) : resolve())),
    );
  if (fake) await deleteFakeSession(fake.sessionKey);
  if (nameFake) await deleteFakeSession(nameFake.sessionKey);
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("main Google mode authenticates public/private/files surfaces and proxies a real runtime tool turn and PTY", async () => {
  directory = mkdtempSync(join(tmpdir(), "pi-orb-full-main-"));
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const pglitePath = join(directory, "database");
  const database = openControlPlaneDatabase({ kind: "pglite", path: pglitePath })._unsafeUnwrap();
  expect((await database.migrate()).isOk()).toBe(true);
  expect((await database.close()).isOk()).toBe(true);
  fake = await createFakeSession("full-main-google", {
    auth: { accountId: "acct_full_main", device: { manualApprove: true } },
    model: {
      rules: [
        {
          match: { userMessage: { regex: "^run GOOGLE_MAIN_TOOL$" } },
          steps: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: "printf GOOGLE_MAIN_TOOL_OK" },
            },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { toolResultContains: { regex: "GOOGLE_MAIN_TOOL_OK" } },
          steps: [
            { type: "text", content: "GOOGLE_MAIN_ROUNDTRIP_COMPLETE" },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { default: true },
          steps: [
            { type: "text", content: "Notification complete." },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  });
  nameFake = await createFakeSession("full-main-google-name", {
    model: {
      rules: [
        {
          match: { default: true },
          steps: [
            { type: "text", content: "Google main test" },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  });
  // Runtime machine traffic uses an owned internal proxy, just as a deployed HTTPS
  // app ingress supplies its configured Host. Browser tests below set Host explicitly.
  broker = createServer((request, response) => {
    if (!cp) {
      response.writeHead(503).end();
      return;
    }
    const upstream = httpRequest(
      `${cp.baseUrl}${request.url}`,
      { method: request.method, headers: { ...request.headers, host: new URL(appOrigin).host } },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 500, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker listener");
  cp = await startControlPlane({
    port: 0,
    fake,
    nameFake,
    pglitePath,
    processStateDirectory: join(directory, "hosts"),
    authDir: join(directory, "auth"),
    entry: "e2e/google-control-plane-entry.ts",
    readinessPath: "/health",
    readinessHeaders: { host: new URL(appOrigin).host },
    extraEnv: {
      PI_ORB_AUTH_MODE: "google",
      PI_ORB_APP_ORIGIN: appOrigin,
      PI_ORB_HOSTING_ORIGIN: filesOrigin,
      PI_ORB_GOOGLE_CLIENT_ID: "client",
      PI_ORB_GOOGLE_CLIENT_SECRET: "secret",
      PI_ORB_COOKIE_SECRET: "full-main-owned-cookie-secret-at-least-32-characters",
      PI_ORB_MACHINE_SUBJECT: "test-machine",
      PI_ORB_OIDC_ISSUER_URL: appOrigin,
      PI_ORB_BROKER_URL: `http://127.0.0.1:${address.port}`,
      PI_ORB_E2E_GOOGLE_CERT: cert,
      PI_ORB_E2E_GOOGLE_KEY: key,
    },
  });
  const request = (
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
    origin = appOrigin,
  ) =>
    controlPlaneRequest(`${cp?.baseUrl}${path}`, {
      ...options,
      headers: { host: new URL(origin).host, ...options.headers },
    });
  const cookieHeader = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  const login = async (origin: string) => {
    const start = await request(
      `/auth/login?returnTo=${encodeURIComponent(origin === filesOrigin ? "/s/missing/file.js" : "/")}`,
      {},
      origin,
    );
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get("location") ?? "");
    const callback = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        authorization,
        {
          ca: readFileSync(cert),
          lookup(_hostname, options, cb) {
            cb(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
          },
        },
        (response) => {
          response.resume();
          if (response.statusCode !== 302)
            reject(new Error(`Google authorize ${response.statusCode}`));
          else resolve(response.headers.location ?? "");
        },
      );
      req.on("error", reject);
      req.end();
    });
    const target = new URL(callback);
    expect(target.origin).toBe(origin);
    const completed = await request(
      `${target.pathname}${target.search}`,
      { headers: { cookie: cookieHeader(start) } },
      origin,
    );
    expect(completed.status).toBe(302);
    const cookie = cookieHeader(completed);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    return cookie;
  };
  const discovery = await request("/.well-known/openid-configuration");
  expect(discovery.status).toBe(200);
  const metadata = (await discovery.json()) as { issuer: string; jwks_uri: string };
  expect(metadata.issuer).toBe(appOrigin);
  const keys = await waitFor("first public signing key publication", async () => {
    const response = await request(new URL(metadata.jwks_uri).pathname);
    const body = (await response.json()) as { keys?: unknown[]; message?: string };
    if (response.status === 503 && body.message === "no signing keys published yet") return null;
    expect(response.status).toBe(200);
    return body.keys?.length ? body.keys : null;
  });
  expect(keys.length).toBeGreaterThan(0);
  expect((await request("/api/v1/projects")).status).toBe(401);
  expect((await request("/api/v1/projects", {}, filesOrigin)).status).toBe(404);
  const cookie = await login(appOrigin);
  const authHeaders = { cookie, origin: appOrigin };
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, {
      method,
      headers: { ...authHeaders, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  expect((await api("/api/v1/projects")).status).toBe(200);
  expect(
    (
      await request("/api/v1/projects", {
        method: "POST",
        headers: { cookie, origin: filesOrigin, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect((await request("/s/missing/file.js", { headers: { cookie } }, filesOrigin)).status).toBe(
    401,
  );
  const filesCookie = await login(filesOrigin);
  expect((await request("/api/v1/projects", { headers: { cookie: filesCookie } })).status).toBe(
    401,
  );
  expect(
    (await request("/s/missing/file.js", { headers: { cookie: filesCookie } }, filesOrigin)).status,
  ).toBe(404);
  const projectId = randomUUID();
  expect(
    (
      await api("/api/v1/projects", "POST", {
        id: projectId,
        name: `google-${projectId.slice(0, 8)}`,
        repositoryUrl: "https://github.com/schani/pi-orb",
      })
    ).status,
  ).toBe(201);
  const orbId = randomUUID();
  expect((await api(`/api/v1/projects/${projectId}/orbs`, "POST", { id: orbId })).status).toBe(202);
  const challenge = await waitFor(
    "device challenge",
    async () => {
      const view = await api(`/api/v1/orbs/${orbId}`);
      const action = view.body["actionRequired"] as { userCode?: string } | undefined;
      return action?.userCode || null;
    },
    { timeoutMs: 60_000 },
  );
  await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: challenge });
  await waitFor(
    "Google-owned process runtime",
    async () => {
      const view = await api(`/api/v1/orbs/${orbId}`);
      if (view.body["state"] === "failed") throw new FatalProbeError(JSON.stringify(view.body));
      return view.body["state"] === "running" ? true : null;
    },
    { timeoutMs: 300_000 },
  );
  const connect = (
    surface: "live" | "terminal",
    protocol: string,
    headers: Record<string, string> = authHeaders,
  ) => {
    const socket = new WebSocket(
      `${cp?.baseUrl.replace("http:", "ws:")}/api/v1/orbs/${orbId}/${surface}`,
      [protocol],
      { headers: { host: new URL(appOrigin).host, ...headers } },
    );
    sockets.push(socket);
    return socket;
  };
  for (const [surface, protocol] of [
    ["live", RUNTIME_SUBPROTOCOL],
    ["terminal", TERMINAL_SUBPROTOCOL],
  ] as const) {
    for (const [headers, status] of [
      [{ origin: appOrigin }, 401],
      [{ cookie, origin: filesOrigin }, 403],
      [{ cookie: filesCookie, origin: appOrigin }, 401],
      [{ cookie: filesCookie, origin: filesOrigin, host: new URL(filesOrigin).host }, 403],
    ] as const) {
      const denied = connect(surface, protocol, headers);
      expect(
        await new Promise<number>((resolve, reject) => {
          denied.once("unexpected-response", (_request, response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          });
          denied.once("open", () => reject(new Error("Unauthorized socket admitted")));
          denied.once("error", reject);
        }),
      ).toBe(status);
    }
  }
  const terminal = connect("terminal", TERMINAL_SUBPROTOCOL);
  let output = "";
  terminal.on("message", (data, binary) => {
    if (binary) output += data.toString();
    else if ((JSON.parse(data.toString()) as { type: string }).type === "terminal.ready")
      terminal.send(Buffer.from("printf 'GOOGLE_PTY_%s\\n' OK\n"));
  });
  await once(terminal, "open");
  terminal.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 200, rows: 30 }));
  await waitFor(
    "real terminal output",
    async () => (output.includes("GOOGLE_PTY_OK") ? true : null),
    { timeoutMs: 30_000 },
  );
  const live = connect("live", RUNTIME_SUBPROTOCOL);
  const frames: ServerFrame[] = [];
  live.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
  await once(live, "open");
  live.send(
    JSON.stringify({
      v: 1,
      type: "client.hello",
      clientInstanceId: randomUUID(),
      afterRecordId: null,
    }),
  );
  const sync = await waitFor(
    "runtime synchronization",
    async () => frames.find((frame) => frame.type === "sync.completed") ?? null,
  );
  let headId = sync.type === "sync.completed" ? sync.headId : null;
  for (const frame of frames) if (frame.type === "history.record") headId = frame.record.id;
  const requestId = randomUUID();
  live.send(
    JSON.stringify({
      v: 1,
      type: "client.request",
      requestId,
      action: {
        type: "message",
        expectedHeadId: headId,
        content: [{ type: "text", text: "run GOOGLE_MAIN_TOOL" }],
      },
    }),
  );
  const accepted = await waitFor(
    "first message accepted",
    async () =>
      frames.find((frame) => frame.type === "request.result" && frame.requestId === requestId) ??
      null,
  );
  expect(accepted).toMatchObject({ result: { type: "accepted" } });
  await waitFor(
    "real bash tool completion",
    async () =>
      frames.find(
        (frame) =>
          frame.type === "runtime.event" &&
          frame.event.type === "tool_state" &&
          frame.event.name === "bash" &&
          frame.event.state === "completed",
      ) ?? null,
    { timeoutMs: 120_000 },
  );
  await waitFor(
    "tool-result model roundtrip",
    async () =>
      frames.find(
        (frame) =>
          frame.type === "history.record" &&
          JSON.stringify(frame.record).includes("GOOGLE_MAIN_ROUNDTRIP_COMPLETE"),
      ) ?? null,
    { timeoutMs: 120_000 },
  );
  expect((await request("/auth/logout", { method: "POST", headers: authHeaders })).status).toBe(
    204,
  );
}, 600_000);
