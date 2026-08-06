import { TAILSCALE_ORB_TAG } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  HttpTailscaleAuthKeyMinter,
  type TailscaleApiTransport,
  type TailscaleHttpResponse,
} from "./client.ts";

const signal = new AbortController().signal;

interface Recorded {
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
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    signal: AbortSignal;
  }): Promise<TailscaleHttpResponse> {
    const recorded: Recorded = { url: args.url, headers: { ...args.headers }, body: args.body };
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
  it("exchanges OAuth credentials and mints a tagged, reusable key", async () => {
    const transport = new FakeTransport([tokenOk, () => json(200, { key: "tskey-auth-abc" })]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", signal);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    if (result.isOk()) expect(result.value).toBe("tskey-auth-abc");

    const [token, create] = transport.requests;
    expect(token?.url).toBe("https://tailscale.test/api/v2/oauth/token");
    expect(token?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(token?.body).toBe("client_id=cid&client_secret=csecret&grant_type=client_credentials");

    expect(create?.url).toBe("https://tailscale.test/api/v2/tailnet/-/keys");
    expect(create?.headers["authorization"]).toBe("Bearer at-1");
    const body = JSON.parse(create?.body ?? "{}") as Record<string, unknown>;
    expect(body["description"]).toBe("pi-orb orb-1");
    expect(body["expirySeconds"]).toBe(7_776_000);
    const capabilities = body["capabilities"] as {
      devices: { create: Record<string, unknown> };
    };
    // Reusable + non-ephemeral so the device record survives a stopped orb;
    // preauthorized + tagged so no admin has to approve the node.
    expect(capabilities.devices.create).toEqual({
      reusable: true,
      ephemeral: false,
      preauthorized: true,
      tags: [TAILSCALE_ORB_TAG],
    });
  });

  it("maps a 4xx on the key create to a terminal rejection", async () => {
    const transport = new FakeTransport([tokenOk, () => ({ status: 403, text: "forbidden tag" })]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", signal);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("rejected");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("forbidden tag");
    }
  });

  it("maps a 5xx on the token exchange to a retryable outage", async () => {
    const transport = new FakeTransport([() => ({ status: 503, text: "upstream down" })]);
    const result = await makeMinter(transport).mintAuthKey("orb-1", signal);
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
    const result = await makeMinter(transport).mintAuthKey("orb-1", signal);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("ECONNRESET");
    }
  });

  it("rejects malformed and incomplete success bodies", async () => {
    const malformed = new FakeTransport([tokenOk, () => ({ status: 200, text: "<html>nope" })]);
    const first = await makeMinter(malformed).mintAuthKey("orb-1", signal);
    expect(first.isErr()).toBe(true);
    if (first.isErr()) {
      expect(first.error.code).toBe("rejected");
      expect(first.error.message).toContain("unparseable JSON");
    }

    const noKey = new FakeTransport([tokenOk, () => json(200, { id: "k1" })]);
    const second = await makeMinter(noKey).mintAuthKey("orb-1", signal);
    expect(second.isErr()).toBe(true);
    if (second.isErr()) expect(second.error.message).toContain("no key");

    const noToken = new FakeTransport([() => json(200, { token_type: "bearer" })]);
    const third = await makeMinter(noToken).mintAuthKey("orb-1", signal);
    expect(third.isErr()).toBe(true);
    if (third.isErr()) expect(third.error.message).toContain("no access_token");
  });
});
