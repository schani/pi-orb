import { TAILSCALE_ORB_TAG } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  HttpTailscaleAuthKeyMinter,
  type TailscaleApiTransport,
  type TailscaleHttpResponse,
} from "./client.ts";

const signal = new AbortController().signal;

interface Recorded {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Scripted transport: matches each request in order against a handler. */
class FakeTransport implements TailscaleApiTransport {
  readonly requests: Recorded[] = [];
  private readonly script: ((request: Recorded) => TailscaleHttpResponse)[];

  constructor(script: ((request: Recorded) => TailscaleHttpResponse)[]) {
    this.script = script;
  }

  async request(args: {
    method?: "GET" | "POST" | "DELETE";
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal: AbortSignal;
  }): Promise<TailscaleHttpResponse> {
    const recorded: Recorded = {
      method: args.method ?? "POST",
      url: args.url,
      headers: { ...args.headers },
      body: args.body ?? "",
    };
    this.requests.push(recorded);
    const step = this.script.shift();
    if (step === undefined) throw new Error(`unscripted request: ${args.url}`);
    return step(recorded);
  }
}

const json = (status: number, body: unknown): TailscaleHttpResponse => ({
  status,
  text: JSON.stringify(body),
});

const tokenOk = (): TailscaleHttpResponse => json(200, { access_token: "at-1" });

function makeMinter(transport: TailscaleApiTransport): HttpTailscaleAuthKeyMinter {
  return new HttpTailscaleAuthKeyMinter(transport, {
    clientId: "cid",
    clientSecret: "csecret",
    baseUrl: "https://tailscale.test",
  });
}

describe("HttpTailscaleAuthKeyMinter", () => {
  it("revokes prior exact-orb keys before minting one non-reusable incarnation key", async () => {
    const transport = new FakeTransport([
      tokenOk,
      () =>
        json(200, [
          { id: "legacy", description: "pi-orb orb-1" },
          { id: "older", description: "pi-orb orb-1 i1" },
          { id: "other", description: "pi-orb orb-10 i1" },
        ]),
      () => ({ status: 204, text: "" }),
      () => ({ status: 204, text: "" }),
      () => json(200, { key: "tskey-auth-abc" }),
    ]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", 2, signal);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    if (result.isOk()) expect(result.value).toBe("tskey-auth-abc");

    const token = transport.requests[0];
    expect(token?.url).toBe("https://tailscale.test/api/v2/oauth/token");
    expect(token?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(token?.body).toBe("client_id=cid&client_secret=csecret&grant_type=client_credentials");
    expect(transport.requests.slice(1, 4).map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://tailscale.test/api/v2/tailnet/-/keys"],
      ["DELETE", "https://tailscale.test/api/v2/tailnet/-/keys/legacy"],
      ["DELETE", "https://tailscale.test/api/v2/tailnet/-/keys/older"],
    ]);

    const create = transport.requests[4];
    expect(create?.url).toBe("https://tailscale.test/api/v2/tailnet/-/keys");
    expect(create?.headers["authorization"]).toBe("Bearer at-1");
    const body = JSON.parse(create?.body ?? "{}") as Record<string, unknown>;
    expect(body["description"]).toBe("pi-orb orb-1 i2");
    expect(body["expirySeconds"]).toBe(7_776_000);
    const capabilities = body["capabilities"] as {
      devices: { create: Record<string, unknown> };
    };
    expect(capabilities.devices.create).toEqual({
      reusable: false,
      ephemeral: false,
      preauthorized: true,
      tags: [TAILSCALE_ORB_TAG],
    });
  });

  it("revokes exact orb keys and removes only the exact tagged device", async () => {
    const transport = new FakeTransport([
      tokenOk,
      () =>
        json(200, [
          { id: "key-match", description: "pi-orb orb-1" },
          { id: "key-incarnation", description: "pi-orb orb-1 i4" },
          { id: "key-other", description: "pi-orb orb-10" },
        ]),
      () => ({ status: 204, text: "" }),
      () => ({ status: 204, text: "" }),
      () =>
        json(200, {
          devices: [
            { id: "device-match", hostname: "pi-orb-orb-1", tags: [TAILSCALE_ORB_TAG] },
            { id: "device-other", hostname: "pi-orb-orb-10", tags: [TAILSCALE_ORB_TAG] },
          ],
        }),
      () => ({ status: 204, text: "" }),
    ]);
    const result = await makeMinter(transport).cleanupOrb("orb-1", signal);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(transport.requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://tailscale.test/api/v2/oauth/token"],
      ["GET", "https://tailscale.test/api/v2/tailnet/-/keys"],
      ["DELETE", "https://tailscale.test/api/v2/tailnet/-/keys/key-match"],
      ["DELETE", "https://tailscale.test/api/v2/tailnet/-/keys/key-incarnation"],
      ["GET", "https://tailscale.test/api/v2/tailnet/-/devices"],
      ["DELETE", "https://tailscale.test/api/v2/device/device-match"],
    ]);
  });

  it("does not mint when revoke-before-mint fails", async () => {
    const transport = new FakeTransport([
      tokenOk,
      () => json(200, [{ id: "old", description: "pi-orb orb-1 i0" }]),
      () => ({ status: 503, text: "tailnet unavailable" }),
    ]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", 1, signal);
    expect(result.isErr() && result.error.retryable).toBe(true);
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  it("serializes concurrent exact-orb mints so only the newest key remains", async () => {
    const keys: Array<{ id: string; description: string }> = [];
    let nextId = 1;
    const transport: TailscaleApiTransport = {
      request: async ({ method = "POST", url, body }) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (url.endsWith("/oauth/token")) return json(200, { access_token: "at-1" });
        if (method === "GET") return json(200, keys);
        if (method === "DELETE") {
          const id = url.split("/").at(-1);
          const index = keys.findIndex((key) => key.id === id);
          if (index >= 0) keys.splice(index, 1);
          return { status: 204, text: "" };
        }
        const description = String(
          (JSON.parse(body ?? "{}") as Record<string, unknown>)["description"],
        );
        keys.push({ id: `key-${nextId++}`, description });
        return json(200, { key: `secret-${nextId}` });
      },
    };
    const minter = makeMinter(transport);
    const [first, second] = await Promise.all([
      minter.mintAuthKey("orb-1", 1, signal),
      minter.mintAuthKey("orb-1", 2, signal),
    ]);
    expect(first.isOk() && second.isOk()).toBe(true);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.description).toBe("pi-orb orb-1 i2");
  });

  it("maps a 4xx on the key create to a terminal rejection", async () => {
    const transport = new FakeTransport([
      tokenOk,
      () => json(200, []),
      () => ({ status: 403, text: "forbidden tag" }),
    ]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", 0, signal);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("rejected");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("forbidden tag");
    }
  });

  it("maps a 5xx on the token exchange to a retryable outage", async () => {
    const transport = new FakeTransport([() => ({ status: 503, text: "upstream down" })]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", 0, signal);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("unavailable");
      expect(result.error.retryable).toBe(true);
    }
    // The key create is never attempted without a token.
    expect(transport.requests.length).toBe(1);
  });

  it("maps a transport rejection to a retryable outage", async () => {
    const transport = new FakeTransport([
      () => {
        throw new Error("ECONNRESET");
      },
    ]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", 0, signal);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("ECONNRESET");
    }
  });

  it("rejects malformed and incomplete success bodies", async () => {
    const malformed = new FakeTransport([
      tokenOk,
      () => json(200, []),
      () => ({ status: 200, text: "<html>nope" }),
    ]);
    const first = await makeMinter(malformed).mintAuthKey("orb-1", 0, signal);
    expect(first.isErr()).toBe(true);
    if (first.isErr()) {
      expect(first.error.code).toBe("rejected");
      expect(first.error.message).toContain("unparseable JSON");
    }

    const noKey = new FakeTransport([tokenOk, () => json(200, []), () => json(200, { id: "k1" })]);
    const second = await makeMinter(noKey).mintAuthKey("orb-1", 0, signal);
    expect(second.isErr()).toBe(true);
    if (second.isErr()) expect(second.error.message).toContain("no key");

    const noToken = new FakeTransport([() => json(200, { token_type: "bearer" })]);
    const third = await makeMinter(noToken).mintAuthKey("orb-1", 0, signal);
    expect(third.isErr()).toBe(true);
    if (third.isErr()) expect(third.error.message).toContain("no access_token");
  });
});
