import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import { TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import { chromium, expect as expectPage } from "@playwright/test";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  fakeControl,
  startControlPlane,
  waitFor,
} from "./harness.ts";

const PORT = 7168;
const REPOSITORY_URL = "https://github.com/schani/pi-orb";
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const scenario = (accountId: string, owner: "alice" | "bob") => ({
  auth: { accountId, device: { manualApprove: true } },
  model: {
    rules: [
      {
        match: { userMessage: { regex: `^${owner.toUpperCase()}_MODEL_IDENTITY$` } },
        steps: [
          { type: "text", content: `${owner.toUpperCase()}_MODEL_COMPLETE` },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
        steps: [
          { type: "text", content: `${owner} Luna summary` },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { userMessage: { regex: "^ALICE_CHILD_OWNER$" } },
        steps: [
          { type: "text", content: "ALICE_CHILD_COMPLETE" },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
});

type Principal = "alice" | "bob" | "ops";
type InferenceObservation = { authorization: string; body: string; owner: "alice" | "bob" };

let fake: FakeSession;
let bobFake: FakeSession;
let aliceNameFake: FakeSession;
let bobNameFake: FakeSession;
let control: ControlPlaneHandle;
let root = "";
let webDist = "";
let inferenceServer: Server;
let githubServer: Server;
let inferenceBaseUrl = "";
let githubBaseUrl = "";
const inferenceObservations: InferenceObservation[] = [];
const approvedGithubCodes = new Set<string>();
const githubDevices = new Map<string, { userCode: string; owner: "alice" | "bob" }>();
let nextGithubOwner: "alice" | "bob" = "alice";

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("missing port"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function request(
  principal: Principal,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${control.baseUrl}${path}`, {
    method,
    headers: {
      "x-pi-orb-e2e-principal": principal,
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function orb(principal: Principal, id: string) {
  return request(principal, "GET", `/api/v1/orbs/${id}`);
}

function auth(owner: "alice" | "bob") {
  const id = owner === "alice" ? ALICE : BOB;
  return JSON.parse(readFileSync(join(control.authDir, "users", id, "auth.json"), "utf8")) as {
    "openai-codex": { access: string };
  };
}

function shellEncoded(text: string): string {
  return [...text].map((character) => `\\${character.charCodeAt(0).toString(8)}`).join("");
}

function runtimeMetadata(orbId: string) {
  return JSON.parse(
    readFileSync(join(root, "process-hosts", encodeURIComponent(orbId), "host.json"), "utf8"),
  ) as { runtimeToken: string };
}

async function terminalRun(orbId: string, command: string, until: string): Promise<string> {
  const socket = new WebSocket(
    `${control.baseUrl.replace("http", "ws")}/api/v1/orbs/${orbId}/terminal`,
    [TERMINAL_SUBPROTOCOL],
    { headers: { "x-pi-orb-e2e-principal": "alice" } },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let output = "";
    const complete = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`terminal command timed out: ${command}`)),
        30_000,
      );
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          output += data.toString();
          if (output.includes(until)) {
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        const frame = JSON.parse(data.toString()) as {
          type?: string;
          error?: { message?: string };
        };
        if (frame.type === "terminal.ready") socket.send(Buffer.from(`${command}\r`));
        if (frame.type === "terminal.error")
          reject(new Error(frame.error?.message ?? "terminal error"));
      });
    });
    socket.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 160, rows: 30 }));
    await complete;
    return output;
  } finally {
    socket.close();
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-orb-stage3-e2e-"));
  webDist = join(root, "web");
  const webRoot = join(import.meta.dirname, "../apps/web");
  await build({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: webDist, emptyOutDir: true },
  });
  fake = await createFakeSession(
    `pi-orb-stage3-alice-${Date.now()}`,
    scenario("alice-account", "alice"),
  );
  bobFake = await createFakeSession(
    `pi-orb-stage3-bob-${Date.now()}`,
    scenario("bob-account", "bob"),
  );
  aliceNameFake = await createFakeSession(`pi-orb-stage3-alice-name-${Date.now()}`, {
    auth: { accountId: "alice-account" },
    model: {
      rules: [
        {
          match: { default: true },
          steps: [
            { type: "text", content: "Alice Owner Name" },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  });
  bobNameFake = await createFakeSession(`pi-orb-stage3-bob-name-${Date.now()}`, {
    auth: { accountId: "bob-account" },
    model: {
      rules: [
        {
          match: { default: true },
          steps: [
            { type: "text", content: "Bob Owner Name" },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  });

  inferenceServer = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const authorization = String(incoming.headers.authorization ?? "");
    const aliceAccess = (() => {
      try {
        return auth("alice")["openai-codex"].access;
      } catch {
        return "";
      }
    })();
    const bobAccess = (() => {
      try {
        return auth("bob")["openai-codex"].access;
      } catch {
        return "";
      }
    })();
    const owner = authorization === `Bearer ${bobAccess}` ? "bob" : "alice";
    if (authorization !== `Bearer ${owner === "alice" ? aliceAccess : bobAccess}`) {
      outgoing.writeHead(401).end(JSON.stringify({ error: "unknown synthetic token" }));
      return;
    }
    const encoding = incoming.headers["content-encoding"];
    const observedBody =
      encoding === "br"
        ? brotliDecompressSync(body).toString()
        : encoding === "gzip"
          ? gunzipSync(body).toString()
          : encoding === "zstd" || body.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
            ? zstdDecompressSync(body).toString()
            : body.toString();
    inferenceObservations.push({ authorization, body: observedBody, owner });
    const naming = observedBody.includes("Return only a short descriptive orb name");
    const target = naming
      ? owner === "alice"
        ? aliceNameFake.inferenceBaseUrl
        : bobNameFake.inferenceBaseUrl
      : owner === "alice"
        ? fake.inferenceBaseUrl
        : bobFake.inferenceBaseUrl;
    const forwardedHeaders: Record<string, string> = {
      authorization,
      "content-type": String(incoming.headers["content-type"] ?? "application/json"),
      accept: String(incoming.headers.accept ?? "application/json"),
      ...(typeof encoding === "string" ? { "content-encoding": encoding } : {}),
    };
    const response = await fetch(`${target}${incoming.url ?? ""}`, {
      ...(incoming.method === undefined ? {} : { method: incoming.method }),
      headers: forwardedHeaders,
      ...(body.length === 0 ? {} : { body }),
    });
    const responseHeaders = Object.fromEntries(
      [...response.headers.entries()].filter(
        ([name]) => name !== "content-encoding" && name !== "content-length",
      ),
    );
    outgoing.writeHead(response.status, responseHeaders);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  inferenceBaseUrl = await listen(inferenceServer);

  githubServer = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    outgoing.setHeader("content-type", "application/json");
    if (incoming.url === "/login/device/code") {
      const owner = nextGithubOwner;
      nextGithubOwner = "bob";
      const deviceCode = `github-device-${owner}`;
      const userCode = `GITHUB-${owner.toUpperCase()}`;
      githubDevices.set(deviceCode, { userCode, owner });
      outgoing.end(
        JSON.stringify({
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${githubBaseUrl}/verify`,
          expires_in: 600,
          interval: 0,
        }),
      );
      return;
    }
    if (incoming.url === "/login/oauth/access_token") {
      const device = githubDevices.get(form.get("device_code") ?? "");
      if (device === undefined || !approvedGithubCodes.has(device.userCode)) {
        outgoing.end(JSON.stringify({ error: "authorization_pending" }));
        return;
      }
      outgoing.end(
        JSON.stringify({
          access_token: `github-access-${device.owner}`,
          refresh_token: `github-refresh-${device.owner}`,
          expires_in: 3600,
        }),
      );
      return;
    }
    if (incoming.url === "/user") {
      const owner = String(incoming.headers.authorization).endsWith("bob") ? "bob" : "alice";
      outgoing.end(JSON.stringify({ login: `${owner}-github-account` }));
      return;
    }
    outgoing.writeHead(404).end("{}");
  });
  githubBaseUrl = await listen(githubServer);

  control = await startControlPlane({
    pglitePath: join(root, "control-plane.pglite"),
    processStateDirectory: join(root, "process-hosts"),
    authDir: join(root, "auth"),
    webDist,
    hostingRoot: join(root, "hosting"),
    port: PORT,
    fake: { ...fake, inferenceBaseUrl },
    entry: "e2e/two-user-control-plane-entry.ts",
    readinessHeaders: { "x-pi-orb-e2e-principal": "alice" },
    extraEnv: {
      PI_ORB_E2E_ALICE_OAUTH_URL: fake.oauthBaseUrl,
      PI_ORB_E2E_ALICE_INFERENCE_URL: inferenceBaseUrl,
      PI_ORB_E2E_BOB_OAUTH_URL: bobFake.oauthBaseUrl,
      PI_ORB_E2E_BOB_INFERENCE_URL: inferenceBaseUrl,
      PI_ORB_GITHUB_CLIENT_ID: "synthetic-client",
      PI_ORB_GITHUB_CLIENT_SECRET: "synthetic-secret",
      PI_ORB_GITHUB_OAUTH_URL: githubBaseUrl,
      PI_ORB_GITHUB_API_URL: githubBaseUrl,
    },
  });
}, 120_000);

afterAll(async () => {
  await control?.stop();
  await new Promise<void>((resolve) => inferenceServer?.close(() => resolve()));
  await new Promise<void>((resolve) => githubServer?.close(() => resolve()));
  if (fake !== undefined) await deleteFakeSession(fake.sessionKey);
  if (bobFake !== undefined) await deleteFakeSession(bobFake.sessionKey);
  if (aliceNameFake !== undefined) await deleteFakeSession(aliceNameFake.sessionKey);
  if (bobNameFake !== undefined) await deleteFakeSession(bobNameFake.sessionKey);
  if (root !== "") rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("authorized two-user credentials", () => {
  it("uses each project owner's model, GitHub, naming, summary, and child credentials", async () => {
    const aliceProject = randomUUID();
    const bobProject = randomUUID();
    const aliceOrb = randomUUID();
    const bobOrb = randomUUID();
    for (const [principal, id] of [
      ["alice", aliceProject],
      ["bob", bobProject],
    ] as const) {
      const created = await request(principal, "POST", "/api/v1/projects", {
        id,
        name: "same project name",
        repositoryUrl: REPOSITORY_URL,
      });
      expect(created.status).toBe(201);
    }
    expect((await request("alice", "GET", "/api/v1/projects")).body.items).toHaveLength(1);
    expect((await request("bob", "GET", "/api/v1/projects")).body.items).toHaveLength(1);
    expect(
      (await request("alice", "POST", `/api/v1/projects/${aliceProject}/orbs`, { id: aliceOrb }))
        .status,
    ).toBe(202);
    expect(
      (await request("bob", "POST", `/api/v1/projects/${bobProject}/orbs`, { id: bobOrb })).status,
    ).toBe(202);

    const codexChallenges = await waitFor(
      "independent Codex challenges",
      async () => {
        const [a, b] = await Promise.all([orb("alice", aliceOrb), orb("bob", bobOrb)]);
        const ac = a.body.actionRequired as Record<string, unknown> | undefined;
        const bc = b.body.actionRequired as Record<string, unknown> | undefined;
        return ac?.type === "openai_codex_device_login" &&
          ac.userCode &&
          ac.verificationUri &&
          bc?.type === "openai_codex_device_login" &&
          bc.userCode &&
          bc.verificationUri
          ? { a: String(ac.userCode), b: String(bc.userCode) }
          : null;
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    const browser = await chromium.launch({ headless: true });
    try {
      const owner = await browser.newContext({
        extraHTTPHeaders: { "x-pi-orb-e2e-principal": "alice" },
      });
      const ownerPage = await owner.newPage();
      await ownerPage.goto(`${control.baseUrl}/#/orbs/${aliceOrb}`);
      await expectPage(ownerPage.getByText(codexChallenges.a, { exact: true })).toBeVisible();
      await owner.close();
      const coworker = await browser.newContext({
        extraHTTPHeaders: { "x-pi-orb-e2e-principal": "bob" },
      });
      const page = await coworker.newPage();
      await page.goto(`${control.baseUrl}/#/orbs/${aliceOrb}`);
      await expectPage(
        page.getByText("Project owner login required for openai-codex."),
      ).toBeVisible();
      expect(await page.locator("body").textContent()).not.toContain(codexChallenges.a);
      await coworker.close();
    } finally {
      await browser.close();
    }
    const opsCodex = await request("ops", "GET", `/api/v1/orbs/${aliceOrb}`, undefined, {
      "x-pi-orb-user-id": ALICE,
    });
    expect(opsCodex.body.actionRequired).toEqual({
      type: "owner_login_required",
      provider: "openai-codex",
    });
    expect(JSON.stringify(opsCodex.body)).not.toContain(codexChallenges.a);

    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: codexChallenges.a });
    const aliceGithub = await waitFor("Alice GitHub challenge", async () => {
      const action = (await orb("alice", aliceOrb)).body.actionRequired as
        | Record<string, unknown>
        | undefined;
      return action?.type === "github_device_login" && action.userCode && action.verificationUri
        ? String(action.userCode)
        : null;
    });
    expect((await orb("bob", bobOrb)).body.state).not.toBe("running");
    await fakeControl(bobFake.sessionKey, "/deviceauth/approve", { user_code: codexChallenges.b });
    const bobGithub = await waitFor("Bob GitHub challenge", async () => {
      const action = (await orb("bob", bobOrb)).body.actionRequired as
        | Record<string, unknown>
        | undefined;
      return action?.type === "github_device_login" && action.userCode && action.verificationUri
        ? String(action.userCode)
        : null;
    });
    expect(aliceGithub).not.toBe(bobGithub);
    const opsGithub = await request("ops", "GET", `/api/v1/orbs/${aliceOrb}`, undefined, {
      "x-pi-orb-user-id": ALICE,
    });
    expect(opsGithub.body.actionRequired).toEqual({
      type: "owner_login_required",
      provider: "github",
    });
    expect(JSON.stringify(opsGithub.body)).not.toContain(aliceGithub);

    approvedGithubCodes.add(aliceGithub);
    await waitFor(
      "Alice runtime running",
      async () => ((await orb("alice", aliceOrb)).body.state === "running" ? true : null),
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    expect((await orb("bob", bobOrb)).body.state).not.toBe("running");
    approvedGithubCodes.add(bobGithub);
    await waitFor(
      "Bob runtime running",
      async () => ((await orb("bob", bobOrb)).body.state === "running" ? true : null),
      { timeoutMs: 120_000, intervalMs: 500 },
    );

    for (const [id, owner] of [
      [aliceOrb, "alice"],
      [bobOrb, "bob"],
    ] as const) {
      const marker = `GITHUB_GRANT_${owner.toUpperCase()}_DONE`;
      const output = await terminalRun(
        id,
        `gh auth token; printf '${shellEncoded(marker)}\\n'`,
        marker,
      );
      expect(output).toContain(`github-access-${owner}`);
    }

    const aliceAuth = auth("alice");
    const bobAuth = auth("bob");
    expect(aliceAuth["openai-codex"].access).not.toBe(bobAuth["openai-codex"].access);

    for (const [principal, id, text] of [
      ["alice", aliceOrb, "ALICE_MODEL_IDENTITY"],
      ["bob", bobOrb, "BOB_MODEL_IDENTITY"],
    ] as const) {
      expect(
        (
          await request(principal, "PUT", `/api/v1/orbs/${id}/messages/${randomUUID()}`, {
            content: [{ type: "text", text }],
          })
        ).status,
      ).toBe(202);
    }
    await waitFor(
      "both owner model turns and Luna summaries",
      async () => {
        const [a, b] = await Promise.all([
          request("alice", "GET", `/api/v1/orbs/${aliceOrb}/history`),
          request("bob", "GET", `/api/v1/orbs/${bobOrb}/history`),
        ]);
        const historyDone =
          JSON.stringify(a.body).includes("ALICE_MODEL_COMPLETE") &&
          JSON.stringify(b.body).includes("BOB_MODEL_COMPLETE");
        const summaries = inferenceObservations.filter((call) =>
          call.body.includes("Write a single short desktop-notification sentence"),
        );
        return historyDone &&
          summaries.some((call) => call.owner === "alice") &&
          summaries.some((call) => call.owner === "bob")
          ? true
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 250 },
    );
    await waitFor(
      "owner-selected Luna names",
      async () => {
        const [a, b] = await Promise.all([orb("alice", aliceOrb), orb("bob", bobOrb)]);
        return a.body.name === "Alice Owner Name" && b.body.name === "Bob Owner Name" ? true : null;
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    expect(
      inferenceObservations.some(
        (call) =>
          call.owner === "alice" &&
          call.authorization === `Bearer ${aliceAuth["openai-codex"].access}` &&
          call.body.includes("ALICE_MODEL_IDENTITY"),
      ),
    ).toBe(true);
    expect(
      inferenceObservations.some(
        (call) =>
          call.owner === "bob" &&
          call.authorization === `Bearer ${bobAuth["openai-codex"].access}` &&
          call.body.includes("BOB_MODEL_IDENTITY"),
      ),
    ).toBe(true);
    expect(
      inferenceObservations.some(
        (call) =>
          call.owner === "alice" && call.body.includes("Return only a short descriptive orb name"),
      ),
    ).toBe(true);
    expect(
      inferenceObservations.some(
        (call) =>
          call.owner === "bob" && call.body.includes("Return only a short descriptive orb name"),
      ),
    ).toBe(true);

    for (const [id, owner] of [
      [aliceOrb, "alice"],
      [bobOrb, "bob"],
    ] as const) {
      for (const [tokenName, expected] of [
        ["model", { accountId: `${owner}-account` }],
        ["github", { accessToken: `github-access-${owner}`, accountId: `${owner}-github-account` }],
      ] as const) {
        const response = await fetch(`${control.baseUrl}/runtime/v1/tokens/${tokenName}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtimeMetadata(id).runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reason: "startup" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject(expected);
      }
    }

    const child = randomUUID();
    const spawned = await terminalRun(
      aliceOrb,
      `pi-orb spawn --id ${child} --prompt ALICE_CHILD_OWNER --name child --json; printf '${shellEncoded("CHILD_SPAWN_DONE")}\\n'`,
      "CHILD_SPAWN_DONE",
    );
    expect(spawned).toContain(`"orbId":"${child}"`);
    await waitFor(
      "same-project child uses Alice model credential",
      async () => {
        const history = await request("bob", "GET", `/api/v1/orbs/${child}/history`);
        return JSON.stringify(history.body).includes("ALICE_CHILD_COMPLETE") ? true : null;
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );
    expect(
      inferenceObservations.some(
        (call) => call.owner === "alice" && call.body.includes("ALICE_CHILD_OWNER"),
      ),
    ).toBe(true);
    expect(
      inferenceObservations.some(
        (call) => call.owner === "bob" && call.body.includes("ALICE_CHILD_OWNER"),
      ),
    ).toBe(false);
  }, 360_000);
});
