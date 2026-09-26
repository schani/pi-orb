import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type {
  BrokerEndpoint,
  BrokerEndpointResult,
  TokenRequestBody,
} from "../domain/broker-client.ts";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { eligibleCodexModels, pickCodexModel } from "../pi/model-select.ts";
import { brokerProviderConfig } from "./provider.ts";

/**
 * Pinned Pi SDK contract test (docs/credentials.md): verifies, against the exact
 * installed `@earendil-works/pi-coding-agent` version, the refresh behavior
 * the broker provider adapter assumes. If a Pi upgrade changes any of these
 * behaviors, this suite must fail before the E2E does.
 *
 * Pinned contract:
 *  1. `login("openai-codex", "oauth", …)` drives our oauth `login` callback
 *     and persists the returned credential — with the synthetic refresh
 *     marker, never a real refresh token — to the auth file.
 *  2. While the stored credential is unexpired, auth resolution returns its
 *     access token without calling `refreshToken`.
 *  3. Once `Date.now() >= expires`, auth resolution calls `refreshToken`,
 *     persists the rotated credential, and serves the new access token;
 *     concurrent resolutions produce exactly one upstream broker request.
 *  4. A failed refresh rejects auth resolution and leaves the stored
 *     credential unchanged; the next resolution retries the refresh.
 *  5. An upstream HTTP 401 during an inference request does NOT trigger any
 *     refresh: this SDK version has no rejected-token reauth path, so token
 *     expiry metadata from the broker must be accurate. (Recovery from a
 *     revoked-but-unexpired token is the broker's proactive rotation, not Pi.)
 */

const PROVIDER = "openai-codex";
const BROKER_MARKER = "pi-orb-broker";

interface ScriptedGrant {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/** In-memory broker endpoint: serves scripted grants and records requests. */
class FakeBrokerEndpoint implements BrokerEndpoint {
  readonly requests: TokenRequestBody[] = [];
  private readonly script: Array<ScriptedGrant | "auth_required">;
  private generation = 0;

  constructor(script: Array<ScriptedGrant | "auth_required">) {
    this.script = [...script];
  }

  requestToken(_task: unknown, body: TokenRequestBody): Promise<BrokerEndpointResult> {
    this.requests.push(body);
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next === undefined || next === "auth_required") {
      return Promise.resolve({ kind: "auth_required" });
    }
    this.generation += 1;
    return Promise.resolve({
      kind: "grant",
      grant: {
        accessToken: next.accessToken,
        accountId: "contract-test-account",
        expiresAt: next.expiresAt,
        generation: this.generation,
      },
    });
  }
}

/**
 * The Codex API provider derives a `chatgpt-account-id` header from the JWT
 * access token before any request; a non-JWT token fails client-side. Real
 * broker tokens are ChatGPT JWTs, so mint a minimal structural stand-in.
 */
function fakeCodexJwt(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "contract-test-acct" } };
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const loginInteraction = {
  prompt: (prompt: { type: string }) =>
    Promise.reject(new Error(`unexpected auth prompt: ${prompt.type}`)),
  notify: () => {},
};

function storedCredential(authPath: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  const credential = parsed[PROVIDER];
  expect(credential, `auth file has a ${PROVIDER} credential`).toBeDefined();
  return credential as Record<string, unknown>;
}

describe("Pi SDK broker provider contract (pinned SDK version)", () => {
  let workDir: string;
  let authPath: string;
  const task = new NoSimulationTask("broker-contract-test", false);

  const createRuntime = async (
    endpoint: FakeBrokerEndpoint,
    options: { inferenceBaseUrl?: string } = {},
  ): Promise<ModelRuntime> => {
    const runtime = await ModelRuntime.create({ authPath, allowModelNetwork: false });
    runtime.registerProvider(
      PROVIDER,
      brokerProviderConfig(task, new BrokerTokenClient(endpoint), options),
    );
    return runtime;
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pi-orb-contract-"));
    authPath = join(workDir, "pi-auth.json");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("provides the four selectable image-capable models in the installed catalog", async () => {
    const runtime = await createRuntime(new FakeBrokerEndpoint([]));
    const catalog = runtime.getModels(PROVIDER);
    const model = pickCodexModel(catalog);
    expect(model?.id).toBe("gpt-6-astra");
    expect(model?.input).toContain("image");
    expect(eligibleCodexModels(catalog).map(({ id }) => id)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-5.6-terra",
      "gpt-6-luna",
    ]);
    const luna = runtime.getModel(PROVIDER, "gpt-6-luna");
    expect(luna).toMatchObject({
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      provider: PROVIDER,
      api: "openai-codex-responses",
    });
    expect(luna?.input).toContain("image");
    expect(runtime.getModel(PROVIDER, "gpt-6-terra")).toBeUndefined();
  });

  it("login drives the broker and persists only the synthetic refresh marker", async () => {
    const endpoint = new FakeBrokerEndpoint([
      { accessToken: "token-1", expiresAt: Date.now() + 3_600_000 },
    ]);
    const runtime = await createRuntime(endpoint);

    expect(await runtime.getAuth(PROVIDER)).toBeUndefined();

    await runtime.login(PROVIDER, "oauth", loginInteraction);
    expect(endpoint.requests).toEqual([{ reason: "startup" }]);

    const credential = storedCredential(authPath);
    expect(credential["type"]).toBe("oauth");
    expect(credential["access"]).toBe("token-1");
    expect(credential["refresh"]).toBe(BROKER_MARKER);
    // The serialized auth file must never contain anything but the marker in
    // any refresh-shaped field.
    expect(readFileSync(authPath, "utf8")).not.toMatch(/refresh[^"]*":\s*"(?!pi-orb-broker")/);
  });

  it("resolution with an unexpired credential returns its token without refreshing", async () => {
    const endpoint = new FakeBrokerEndpoint([
      { accessToken: "token-1", expiresAt: Date.now() + 3_600_000 },
    ]);
    const runtime = await createRuntime(endpoint);
    await runtime.login(PROVIDER, "oauth", loginInteraction);

    for (let i = 0; i < 3; i += 1) {
      const resolution = await runtime.getAuth(PROVIDER);
      expect(resolution?.auth.apiKey).toBe("token-1");
    }
    // Only the startup login reached the broker.
    expect(endpoint.requests.map((request) => request.reason)).toEqual(["startup"]);
  });

  it("restores safe grant metadata from unexpired auth without contacting the broker", async () => {
    const token = fakeCodexJwt();
    const expiresAt = Date.now() + 3_600_000;
    const endpoint = new FakeBrokerEndpoint([{ accessToken: token, expiresAt }]);
    const initial = await createRuntime(endpoint);
    await initial.login(PROVIDER, "oauth", loginInteraction);
    expect(storedCredential(authPath)).toMatchObject({
      access: token,
      refresh: BROKER_MARKER,
      expires: expiresAt,
      brokerGeneration: 1,
    });

    const provider = brokerProviderConfig(task, new BrokerTokenClient(endpoint), {});
    const restored = await ModelRuntime.create({ authPath, allowModelNetwork: false });
    restored.registerProvider(PROVIDER, provider);
    expect(provider.getRequestDiagnostics(token)).toBeUndefined();
    expect((await restored.getAuth(PROVIDER))?.auth.apiKey).toBe(token);
    expect(provider.getRequestDiagnostics(token)).toEqual({
      brokerGeneration: 1,
      tokenExpiresAt: expiresAt,
    });
    expect(endpoint.requests).toEqual([{ reason: "startup" }]);
  });

  it("retains known expiry when a restored credential has no generation", () => {
    const provider = brokerProviderConfig(
      task,
      new BrokerTokenClient(new FakeBrokerEndpoint([])),
      {},
    );
    const credentials = {
      access: "old-access",
      refresh: BROKER_MARKER,
      expires: Date.now() + 60_000,
    };
    expect(provider.oauth.getApiKey(credentials)).toBe("old-access");
    expect(provider.getRequestDiagnostics("old-access")).toEqual({
      tokenExpiresAt: credentials.expires,
    });
  });

  it("omits ambiguous metadata when a bearer is reused across generations", async () => {
    const token = fakeCodexJwt();
    const endpoint = new FakeBrokerEndpoint([
      { accessToken: token, expiresAt: Date.now() + 3_600_000 },
      { accessToken: token, expiresAt: Date.now() + 3_700_000 },
    ]);
    const provider = brokerProviderConfig(task, new BrokerTokenClient(endpoint), {});
    const first = await provider.oauth.login();
    expect(provider.getRequestDiagnostics(token)?.brokerGeneration).toBe(1);
    await provider.oauth.refreshToken(first);
    expect(provider.getRequestDiagnostics(token)).toBeUndefined();
    provider.oauth.getApiKey(first);
    expect(provider.getRequestDiagnostics(token)).toBeUndefined();
  });

  it("an expired credential is refreshed once, persisted, and served to all waiters", async () => {
    const endpoint = new FakeBrokerEndpoint([
      { accessToken: "token-expired", expiresAt: Date.now() - 1_000 },
      { accessToken: "token-2", expiresAt: Date.now() + 3_600_000 },
    ]);
    const runtime = await createRuntime(endpoint);
    await runtime.login(PROVIDER, "oauth", loginInteraction);

    const resolutions = await Promise.all(
      Array.from({ length: 5 }, () => runtime.getAuth(PROVIDER)),
    );
    for (const resolution of resolutions) {
      expect(resolution?.auth.apiKey).toBe("token-2");
    }
    // Exactly one upstream refresh for the whole concurrent burst (Pi's
    // double-checked credential lock composed with the client singleflight).
    expect(endpoint.requests.map((request) => request.reason)).toEqual(["startup", "expiring"]);

    const credential = storedCredential(authPath);
    expect(credential["access"]).toBe("token-2");
    expect(credential["refresh"]).toBe(BROKER_MARKER);
  });

  it("a failed refresh rejects resolution, keeps the stored credential, and is retried", async () => {
    const endpoint = new FakeBrokerEndpoint([
      { accessToken: "token-expired", expiresAt: Date.now() - 1_000 },
      "auth_required",
      { accessToken: "token-3", expiresAt: Date.now() + 3_600_000 },
    ]);
    const runtime = await createRuntime(endpoint);
    await runtime.login(PROVIDER, "oauth", loginInteraction);

    await expect(runtime.getAuth(PROVIDER)).rejects.toThrow(/refresh/i);
    expect(storedCredential(authPath)["access"]).toBe("token-expired");

    const recovered = await runtime.getAuth(PROVIDER);
    expect(recovered?.auth.apiKey).toBe("token-3");
    expect(endpoint.requests.map((request) => request.reason)).toEqual([
      "startup",
      "expiring",
      "expiring",
    ]);
  });

  it.each(["missing_api_key", "invalid_jwt", "payload_rejected", "invalid_header"])(
    "does not fabricate transport facts when preflight fails: %s",
    async (failure) => {
      const runtime = await createRuntime(new FakeBrokerEndpoint([]));
      const model = runtime.getModels(PROVIDER)[0];
      if (model?.api !== "openai-codex-responses") throw new Error("no Codex model");
      const codexModel = model as Model<"openai-codex-responses">;
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be called")));
      const options = {
        ...(failure === "missing_api_key"
          ? {}
          : { apiKey: failure === "invalid_jwt" ? "not-a-jwt" : fakeCodexJwt() }),
        fetch,
        ...(failure === "payload_rejected"
          ? { onPayload: () => Promise.reject(new Error("preflight rejected")) }
          : {}),
        ...(failure === "invalid_header" ? { headers: { "bad\nheader": "value" } } : {}),
        codexBrokerDiagnostics: { brokerGeneration: 3, tokenExpiresAt: Date.now() + 3_600_000 },
      };
      const message = await codexStream(
        codexModel,
        normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
        options,
      ).result();
      expect(message.stopReason).toBe("error");
      expect(message.diagnostics?.filter((item) => item.type === "codex_failure") ?? []).toEqual(
        [],
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("completes an original fetch failure when its code getter throws during diagnostics", async () => {
    const runtime = await createRuntime(new FakeBrokerEndpoint([]));
    const model = runtime.getModels(PROVIDER)[0];
    if (model?.api !== "openai-codex-responses") throw new Error("no Codex model");
    const error = new Error("original fetch failure");
    Object.defineProperty(error, "code", {
      get: () => {
        throw new Error("diagnostic getter secret");
      },
    });
    const fetch = vi.fn(() => Promise.reject(error));
    const result = await codexStream(
      model as Model<"openai-codex-responses">,
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
      { apiKey: fakeCodexJwt(), transport: "sse", maxRetries: 0, fetch },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("original fetch failure");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ type: "codex_failure", transport: "sse", attempt: 1 }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("diagnostic getter secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 1000);

  it("completes the original HTTP failure when request-ID lookup throws", async () => {
    const runtime = await createRuntime(new FakeBrokerEndpoint([]));
    const model = runtime.getModels(PROVIDER)[0];
    if (model?.api !== "openai-codex-responses") throw new Error("no Codex model");
    const response = new Response(
      JSON.stringify({ error: { message: "original unauthorized", code: "invalid_api_key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    const get = response.headers.get.bind(response.headers);
    Object.defineProperty(response.headers, "get", {
      value: (name: string) => {
        if (name === "x-request-id") throw new Error("diagnostic header secret");
        return get(name);
      },
    });
    const fetch = vi.fn(() => Promise.resolve(response));
    const result = await codexStream(
      model as Model<"openai-codex-responses">,
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
      { apiKey: fakeCodexJwt(), transport: "sse", maxRetries: 0, fetch },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("original unauthorized");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ type: "codex_failure", status: 401, code: "invalid_api_key" }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("diagnostic header secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a throwing diagnostic callback without blocking inference", async () => {
    const token = fakeCodexJwt();
    const endpoint = new FakeBrokerEndpoint([
      { accessToken: token, expiresAt: Date.now() + 3_600_000 },
    ]);
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    try {
      const provider = brokerProviderConfig(task, new BrokerTokenClient(endpoint), {
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      const runtime = await ModelRuntime.create({ authPath, allowModelNetwork: false });
      runtime.registerProvider(PROVIDER, {
        ...provider,
        getRequestDiagnostics: () => {
          throw new Error("diagnostic callback secret");
        },
      });
      await runtime.login(PROVIDER, "oauth", loginInteraction);
      await runtime.refresh({ allowNetwork: false });
      const model = runtime.getModels(PROVIDER)[0];
      if (!model) throw new Error("no model");
      const result = await runtime.complete(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { transport: "sse" },
      );
      expect(result.stopReason).toBe("error");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ type: "codex_failure", status: 401 }),
      );
      expect(JSON.stringify(result)).not.toContain("diagnostic callback secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("binds grant metadata to each actual bearer under out-of-order failures", async () => {
    const firstToken = fakeCodexJwt();
    const secondToken = firstToken.replace(/\.sig$/, ".sig2");
    const firstExpiry = Date.now() + 3_600_000;
    const secondExpiry = firstExpiry + 1_000;
    let pending: import("node:http").ServerResponse | undefined;
    let firstArrived!: () => void;
    const firstArrival = new Promise<void>((resolve) => {
      firstArrived = resolve;
    });
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization ?? "");
      if (request.headers.authorization === `Bearer ${firstToken}`) {
        pending = response;
        firstArrived();
      } else {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    try {
      const endpoint = new FakeBrokerEndpoint([
        { accessToken: firstToken, expiresAt: firstExpiry },
        { accessToken: secondToken, expiresAt: secondExpiry },
      ]);
      const provider = brokerProviderConfig(task, new BrokerTokenClient(endpoint), {
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      const runtime = await ModelRuntime.create({ authPath, allowModelNetwork: false });
      runtime.registerProvider(PROVIDER, provider);
      await runtime.login(PROVIDER, "oauth", loginInteraction);
      await runtime.refresh({ allowNetwork: false });
      const model = runtime.getModels(PROVIDER)[0];
      if (!model) throw new Error("no model");
      const context = {
        messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
      };
      const oldRequest = runtime.complete(model, context, { transport: "sse", apiKey: firstToken });
      await firstArrival;
      await provider.oauth.refreshToken({
        access: firstToken,
        refresh: BROKER_MARKER,
        expires: firstExpiry,
      });
      const newResult = await runtime.complete(model, context, {
        transport: "sse",
        apiKey: secondToken,
      });
      pending?.writeHead(401, { "content-type": "application/json" });
      pending?.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
      const oldResult = await oldRequest;
      const oldFailure = oldResult.diagnostics?.findLast((item) => item.type === "codex_failure");
      const newFailure = newResult.diagnostics?.findLast((item) => item.type === "codex_failure");
      expect(oldFailure).toMatchObject({ brokerGeneration: 1, tokenExpiresAt: firstExpiry });
      expect(newFailure).toMatchObject({ brokerGeneration: 2, tokenExpiresAt: secondExpiry });
      expect(seen).toEqual([`Bearer ${firstToken}`, `Bearer ${secondToken}`]);
      expect(JSON.stringify([oldFailure, newFailure])).not.toContain(firstToken);
      expect(JSON.stringify([oldFailure, newFailure])).not.toContain(secondToken);
    } finally {
      pending?.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps WS close and later structured auth failure separate without replaying a partial stream", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    let requests = 0;
    sockets.on("connection", (socket) => {
      requests += 1;
      socket.once("message", () => {
        if (requests === 1) {
          socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
          socket.close(1011, "raw-secret-reason");
        } else {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "invalid_api_key",
              message: "raw-secret-provider-text",
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    try {
      const endpoint = new FakeBrokerEndpoint([
        { accessToken: fakeCodexJwt(), expiresAt: Date.now() + 3_600_000 },
      ]);
      const runtime = await createRuntime(endpoint, {
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      await runtime.login(PROVIDER, "oauth", loginInteraction);
      await runtime.refresh({ allowNetwork: false });
      const model = runtime.getModels(PROVIDER)[0];
      if (!model) throw new Error("no model");
      const context = {
        messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
      };
      const first = await runtime.complete(model, context, { transport: "websocket" });
      expect(first.stopReason).toBe("error");
      expect(first.diagnostics).toContainEqual(
        expect.objectContaining({
          type: "codex_failure",
          transport: "websocket",
          phase: "after_message_stream_start",
          wsCloseCode: 1011,
        }),
      );
      expect(
        JSON.stringify(first.diagnostics?.filter((item) => item.type === "codex_failure")),
      ).not.toContain("raw-secret");
      const second = await runtime.complete(model, context, { transport: "websocket" });
      expect(second.stopReason).toBe("error");
      expect(second.diagnostics).toContainEqual(
        expect.objectContaining({
          type: "codex_failure",
          transport: "websocket",
          code: "invalid_api_key",
        }),
      );
      expect(requests).toBe(2);
      expect(first.content.filter((item) => item.type === "toolCall")).toEqual([]);
      expect(second.content.filter((item) => item.type === "toolCall")).toEqual([]);
      expect(endpoint.requests).toEqual([{ reason: "startup" }]);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    }
  });

  it("keeps a WS pre-start fallback distinct from its final SSE failure", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) =>
      socket.once("message", () => socket.close(1011, "raw-secret-reason")),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    try {
      const endpoint = new FakeBrokerEndpoint([
        { accessToken: fakeCodexJwt(), expiresAt: Date.now() + 3_600_000 },
      ]);
      const runtime = await createRuntime(endpoint, {
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      await runtime.login(PROVIDER, "oauth", loginInteraction);
      await runtime.refresh({ allowNetwork: false });
      const model = runtime.getModels(PROVIDER)[0];
      if (!model) throw new Error("no model");
      const outcome = await runtime.complete(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { transport: "auto" },
      );
      expect(outcome.stopReason).toBe("error");
      expect(outcome.diagnostics?.filter((item) => item.type === "codex_failure")).toEqual([
        expect.objectContaining({
          transport: "websocket",
          phase: "before_message_stream_start",
          wsCloseCode: 1011,
        }),
        expect.objectContaining({ transport: "sse", status: 401, code: "invalid_api_key" }),
      ]);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    }
  });

  it("does not attribute a prior HTTP response to a later transport failure", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "x-request-id": "req_12345678",
          "retry-after-ms": "0",
        });
        response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
      } else {
        response.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    try {
      const endpoint = new FakeBrokerEndpoint([
        { accessToken: fakeCodexJwt(), expiresAt: Date.now() + 3_600_000 },
      ]);
      const runtime = await createRuntime(endpoint, {
        inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      await runtime.login(PROVIDER, "oauth", loginInteraction);
      await runtime.refresh({ allowNetwork: false });
      const model = runtime.getModels(PROVIDER)[0];
      if (!model) throw new Error("no model");
      const result = await runtime.complete(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { transport: "sse", maxRetries: 1 },
      );
      expect(result.stopReason).toBe("error");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          type: "codex_failure",
          transport: "sse",
          attempt: 2,
          phase: "before_message_stream_start",
        }),
      );
      const final = result.diagnostics?.findLast((item) => item.type === "codex_failure");
      expect(final).not.toHaveProperty("status");
      expect(final).not.toHaveProperty("code");
      expect(final).not.toHaveProperty("requestId");
      expect(requests).toBe(2);
      expect(endpoint.requests).toEqual([{ reason: "startup" }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([true, false])(
    "an upstream 401 preserves only available structured metadata (present=%s)",
    async (metadata) => {
      let inferenceRequests = 0;
      let outboundBearer: string | undefined;
      const server: Server = createServer((request, response) => {
        inferenceRequests += 1;
        outboundBearer = request.headers.authorization;
        response.writeHead(401, {
          "content-type": "application/json",
          ...(metadata ? { "x-request-id": "req_12345678" } : {}),
        });
        response.end(
          JSON.stringify({
            error: { message: "Unauthorized", ...(metadata ? { code: "invalid_api_key" } : {}) },
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no server address");

      try {
        const revokedToken = fakeCodexJwt();
        const endpoint = new FakeBrokerEndpoint([
          { accessToken: revokedToken, expiresAt: Date.now() + 3_600_000 },
        ]);
        const runtime = await createRuntime(endpoint, {
          inferenceBaseUrl: `http://127.0.0.1:${address.port}`,
        });
        await runtime.login(PROVIDER, "oauth", loginInteraction);
        await runtime.refresh({ allowNetwork: false });
        const model = runtime.getModels(PROVIDER)[0];
        expect(model, "built-in Codex catalog resolves offline").toBeDefined();
        if (model === undefined) throw new Error("unreachable");

        const outcome = await runtime
          .complete(
            model,
            { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
            // SSE keeps the request on plain HTTP so the fake server sees it;
            // the "auto" WebSocket-first path is exercised by the E2E instead.
            { transport: "sse" },
          )
          .then(
            (message) => ({ rejected: false as const, message }),
            (error: unknown) => ({ rejected: true as const, error }),
          );
        // The operation fails (rejection or an error stop reason) …
        if (!outcome.rejected) {
          expect(outcome.message.stopReason).toBe("error");
          const diagnostic = outcome.message.diagnostics?.findLast(
            (item) => item.type === "codex_failure",
          );
          expect(diagnostic).toMatchObject({
            type: "codex_failure",
            transport: "sse",
            status: 401,
            ...(metadata ? { code: "invalid_api_key", requestId: "req_12345678" } : {}),
          });
          if (!metadata) {
            expect(diagnostic).not.toHaveProperty("code");
            expect(diagnostic).not.toHaveProperty("requestId");
          }
          expect(JSON.stringify(diagnostic)).not.toContain(revokedToken);
        }
        expect(outboundBearer).toBe(`Bearer ${revokedToken}`);
        // … the 401 actually reached our server …
        expect(inferenceRequests).toBeGreaterThan(0);
        // … and Pi made no refresh attempt: the broker saw only the login.
        expect(endpoint.requests.map((request) => request.reason)).toEqual(["startup"]);
        expect(storedCredential(authPath)["access"]).toBe(revokedToken);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
