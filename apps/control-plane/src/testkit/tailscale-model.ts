import { err, ok, type Result } from "neverthrow";
import type { TailscaleApiTransport, TailscaleHttpResponse } from "../adapters/tailscale/client.ts";

interface Key {
  readonly id: string;
  readonly secret: string;
  readonly description: string;
}

/** Shared remote state, not a fake minter: real adapters decide what to revoke. */
export class DeterministicTailscaleApiModel implements TailscaleApiTransport {
  private readonly keys = new Map<string, Key>();
  private readonly devices = new Map<string, string>();
  private nextKey = 1;
  private nextDevice = 1;
  readonly events: string[] = [];

  keyDescriptions(): string[] {
    return [...this.keys.values()].map((key) => key.description);
  }

  /** Non-reusable enrollment returns the identity retained on the guest disk. */
  enroll(host: string, secret: string): Result<string, "invalid_key"> {
    const key = [...this.keys.values()].find((candidate) => candidate.secret === secret);
    if (key === undefined) {
      this.events.push(`enroll rejected ${host}`);
      return err("invalid_key");
    }
    this.keys.delete(key.id);
    const identity = `model-device-${this.nextDevice++}`;
    this.devices.set(identity, host);
    this.events.push(`enroll accepted ${host} ${key.id}`);
    return ok(identity);
  }

  /** Only possession of retained identity resumes a node, never its hostname. */
  resume(identity: string): Result<void, "unknown_device"> {
    return this.devices.has(identity) ? ok(undefined) : err("unknown_device");
  }

  async request(
    args: Parameters<TailscaleApiTransport["request"]>[0],
  ): Promise<TailscaleHttpResponse> {
    const response = (status: number, body: unknown): TailscaleHttpResponse => ({
      status,
      text: JSON.stringify(body),
    });
    if (args.signal.aborted) return response(499, {});
    const path = new URL(args.url).pathname;
    const method = args.method ?? "POST";
    if (path === "/api/v2/oauth/token") return response(200, { access_token: "model-token" });
    if (path === "/api/v2/tailnet/-/keys" && method === "GET") {
      return response(200, {
        keys: [...this.keys.values()].map(({ id, description }) => ({ id, description })),
      });
    }
    if (path === "/api/v2/tailnet/-/keys" && method === "POST") {
      const body = JSON.parse(args.body ?? "{}") as { description: string };
      const id = `model-key-${this.nextKey++}`;
      const key = { id, secret: `model-secret-${id}`, description: body.description };
      this.keys.set(id, key);
      this.events.push(`mint ${id} ${key.description}`);
      return response(200, { id, key: key.secret });
    }
    const id = path.split("/").at(-1) ?? "";
    if (path.startsWith("/api/v2/tailnet/-/keys/") && method === "DELETE") {
      const removed = this.keys.delete(id);
      this.events.push(`revoke ${id}`);
      return response(removed ? 204 : 404, {});
    }
    if (path === "/api/v2/tailnet/-/devices" && method === "GET") {
      return response(200, {
        devices: [...this.devices].map(([id, host]) => ({
          id,
          hostname: host,
          tags: ["tag:pi-orb"],
        })),
      });
    }
    if (path.startsWith("/api/v2/device/") && method === "DELETE") {
      return response(this.devices.delete(id) ? 204 : 404, {});
    }
    return response(404, {});
  }
}
