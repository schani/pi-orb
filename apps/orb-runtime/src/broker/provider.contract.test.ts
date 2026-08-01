import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BrokerEndpoint,
  BrokerEndpointResult,
  TokenRequestBody,
} from "../domain/broker-client.ts";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { brokerProviderConfig } from "./provider.ts";

/**
 * Pinned Pi SDK contract test (DESIGN.md §15.1): verifies, against the exact
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

  it("an upstream 401 does not trigger any refresh path", async () => {
    let inferenceRequests = 0;
    const server: Server = createServer((_request, response) => {
      inferenceRequests += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unauthorized" } }));
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
      }
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
  });
});
