import { TAILSCALE_ORB_TAG } from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { TailscaleError } from "../../domain/errors.ts";

/**
 * Tailscale control-API adapter (docs/ports.md): mints the per-orb tailnet
 * auth key the host providers hand to a new orb host. Keys are minted only at
 * actual host creation, so the OAuth access token is fetched fresh per mint —
 * caching a token that is used a handful of times a day buys nothing and adds
 * an expiry edge.
 */

/** What the host providers need from this adapter. */
export interface TailscaleAuthKeyMinter {
  mintAuthKey(
    orbId: string,
    incarnation: number,
    signal: AbortSignal,
  ): ResultAsync<string, TailscaleError>;
}

export interface TailscaleOrbCleaner {
  cleanupOrb(orbId: string, signal: AbortSignal): ResultAsync<void, TailscaleError>;
}

/** Provider construction option: how orb hosts join the tailnet. */
export interface TailscaleHostOptions {
  readonly minter: TailscaleAuthKeyMinter;
  /** MagicDNS suffix of the tailnet, e.g. "tailabc123.ts.net". */
  readonly tailnetDnsName: string;
}

export interface TailscaleHttpResponse {
  readonly status: number;
  /** Raw body; parsing (and malformed-body classification) belongs to the client. */
  readonly text: string;
}

/**
 * Minimal transport seam over the Tailscale REST API — only POST is ever
 * used. The client is written against this interface so its multi-step flow
 * is unit-testable with a scripted fake.
 */
export interface TailscaleApiTransport {
  request(args: {
    readonly method?: "GET" | "POST" | "DELETE";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  }): Promise<TailscaleHttpResponse>;
}

export class FetchTailscaleApiTransport implements TailscaleApiTransport {
  async request(args: {
    readonly method?: "GET" | "POST" | "DELETE";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  }): Promise<TailscaleHttpResponse> {
    const response = await fetch(args.url, {
      method: args.method ?? "POST",
      headers: { ...args.headers },
      ...(args.body === undefined ? {} : { body: args.body }),
      signal: args.signal,
    });
    return { status: response.status, text: await response.text() };
  }
}

export interface TailscaleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** API origin override (tests); defaults to the public Tailscale API. */
  readonly baseUrl?: string;
}

const REAL_API_BASE_URL = "https://api.tailscale.com";

/** 90 days: comfortably longer than any orb lifetime we expect in the POC. */
const KEY_EXPIRY_SECONDS = 7_776_000;

const unavailable = (message: string): TailscaleError => ({
  type: "tailscale_error",
  code: "unavailable",
  message,
  retryable: true,
});

const rejected = (message: string): TailscaleError => ({
  type: "tailscale_error",
  code: "rejected",
  message,
  retryable: false,
});

/** 5xx is worth another attempt; a 4xx is the tailnet saying no. */
const statusError = (what: string, status: number, body: string): TailscaleError =>
  status >= 500
    ? unavailable(`${what} HTTP ${status}: ${body.slice(0, 200)}`)
    : rejected(`${what} HTTP ${status}: ${body.slice(0, 200)}`);

function parseJson(what: string, text: string): Result<Record<string, unknown>, TailscaleError> {
  const parsed = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => rejected(`${what} returned unparseable JSON`),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return err(rejected(`${what} returned a non-object body`));
  }
  return ok(parsed.value as Record<string, unknown>);
}

export class HttpTailscaleAuthKeyMinter implements TailscaleAuthKeyMinter, TailscaleOrbCleaner {
  private readonly transport: TailscaleApiTransport;
  private readonly config: TailscaleOAuthConfig;
  /** Serialize revoke-before-mint/cleanup for one orb in this adapter process. */
  private readonly orbLocks = new Map<string, Promise<void>>();

  constructor(transport: TailscaleApiTransport, config: TailscaleOAuthConfig) {
    this.transport = transport;
    this.config = config;
  }

  private url(path: string): string {
    return `${this.config.baseUrl ?? REAL_API_BASE_URL}${path}`;
  }

  private async withOrbLock<T>(orbId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.orbLocks.get(orbId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.orbLocks.set(orbId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.orbLocks.get(orbId) === tail) this.orbLocks.delete(orbId);
    }
  }

  /** The single exception boundary of this adapter. */
  private post(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string,
    signal: AbortSignal,
  ): ResultAsync<TailscaleHttpResponse, TailscaleError> {
    return ResultAsync.fromPromise(
      this.transport.request({ url, headers, body, signal }),
      (error) =>
        unavailable(
          `tailscale request failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  private send(
    method: "GET" | "DELETE",
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): ResultAsync<TailscaleHttpResponse, TailscaleError> {
    return ResultAsync.fromPromise(
      this.transport.request({ method, url, headers, signal }),
      (error) =>
        unavailable(
          `tailscale request failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  private async accessToken(signal: AbortSignal): Promise<Result<string, TailscaleError>> {
    const response = await this.post(
      this.url("/api/v2/oauth/token"),
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "client_credentials",
      }).toString(),
      signal,
    );
    if (response.isErr()) return err(response.error);
    if (response.value.status < 200 || response.value.status >= 300) {
      return err(statusError("tailscale oauth token", response.value.status, response.value.text));
    }
    const body = parseJson("tailscale oauth token", response.value.text);
    if (body.isErr()) return err(body.error);
    const token = body.value["access_token"];
    if (typeof token !== "string" || token === "") {
      return err(rejected("tailscale oauth token response has no access_token"));
    }
    return ok(token);
  }

  private async revokeOrbKeys(
    orbId: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<Result<void, TailscaleError>> {
    const keyList = await this.send("GET", this.url("/api/v2/tailnet/-/keys"), headers, signal);
    if (keyList.isErr()) return err(keyList.error);
    if (keyList.value.status < 200 || keyList.value.status >= 300) {
      return err(statusError("tailscale key list", keyList.value.status, keyList.value.text));
    }
    const parsed = Result.fromThrowable(
      () => JSON.parse(keyList.value.text) as unknown,
      () => rejected("tailscale key list returned unparseable JSON"),
    )();
    if (parsed.isErr()) return err(parsed.error);
    const keys = Array.isArray(parsed.value)
      ? parsed.value
      : typeof parsed.value === "object" &&
          parsed.value !== null &&
          Array.isArray((parsed.value as Record<string, unknown>)["keys"])
        ? ((parsed.value as Record<string, unknown>)["keys"] as unknown[])
        : [];
    const legacyDescription = `pi-orb ${orbId}`;
    const incarnationPrefix = `${legacyDescription} i`;
    for (const value of keys) {
      const key = value as Record<string, unknown>;
      const description = key["description"];
      const exact =
        description === legacyDescription ||
        (typeof description === "string" &&
          description.startsWith(incarnationPrefix) &&
          /^\d+$/.test(description.slice(incarnationPrefix.length)));
      if (!exact || typeof key["id"] !== "string") continue;
      const removed = await this.send(
        "DELETE",
        this.url(`/api/v2/tailnet/-/keys/${encodeURIComponent(key["id"])}`),
        headers,
        signal,
      );
      if (removed.isErr()) return err(removed.error);
      if (
        removed.value.status !== 404 &&
        (removed.value.status < 200 || removed.value.status >= 300)
      ) {
        return err(statusError("tailscale key delete", removed.value.status, removed.value.text));
      }
    }
    return ok(undefined);
  }

  /**
   * Non-ephemeral device state persists on the orb's data volume. Auth keys
   * are incarnation-scoped and non-reusable; revoke-before-mint bounds the
   * tailnet to at most one unconsumed exact-orb key.
   * volume, so the same key is replayed after a restart and the device record
   * must survive the offline stretches a stopped orb spends. Preauthorized
   * and tagged so no admin has to approve a node and the tailnet ACLs scope
   * what `tag:pi-orb` may reach.
   */
  cleanupOrb(orbId: string, signal: AbortSignal): ResultAsync<void, TailscaleError> {
    const run = async (): Promise<Result<void, TailscaleError>> => {
      const token = await this.accessToken(signal);
      if (token.isErr()) return err(token.error);
      const headers = { authorization: `Bearer ${token.value}` };
      const revoked = await this.revokeOrbKeys(orbId, headers, signal);
      if (revoked.isErr()) return err(revoked.error);

      const deviceList = await this.send(
        "GET",
        this.url("/api/v2/tailnet/-/devices"),
        headers,
        signal,
      );
      if (deviceList.isErr()) return err(deviceList.error);
      if (deviceList.value.status < 200 || deviceList.value.status >= 300) {
        return err(
          statusError("tailscale device list", deviceList.value.status, deviceList.value.text),
        );
      }
      const parsedDevices = parseJson("tailscale device list", deviceList.value.text);
      if (parsedDevices.isErr()) return err(parsedDevices.error);
      const devices = Array.isArray(parsedDevices.value["devices"])
        ? (parsedDevices.value["devices"] as unknown[])
        : [];
      const hostname = `pi-orb-${orbId}`;
      for (const value of devices) {
        const device = value as Record<string, unknown>;
        const exactName =
          device["hostname"] === hostname ||
          (typeof device["name"] === "string" && device["name"].split(".")[0] === hostname);
        const tags = Array.isArray(device["tags"]) ? device["tags"] : [];
        if (!exactName || !tags.includes(TAILSCALE_ORB_TAG) || typeof device["id"] !== "string") {
          continue;
        }
        const removed = await this.send(
          "DELETE",
          this.url(`/api/v2/device/${encodeURIComponent(device["id"])}`),
          headers,
          signal,
        );
        if (removed.isErr()) return err(removed.error);
        if (
          removed.value.status !== 404 &&
          (removed.value.status < 200 || removed.value.status >= 300)
        ) {
          return err(
            statusError("tailscale device delete", removed.value.status, removed.value.text),
          );
        }
      }
      return ok(undefined);
    };
    return new ResultAsync(this.withOrbLock(orbId, run));
  }

  mintAuthKey(
    orbId: string,
    incarnation: number,
    signal: AbortSignal,
  ): ResultAsync<string, TailscaleError> {
    const run = async (): Promise<Result<string, TailscaleError>> => {
      const token = await this.accessToken(signal);
      if (token.isErr()) return err(token.error);
      const headers = {
        authorization: `Bearer ${token.value}`,
        "content-type": "application/json",
      };
      const revoked = await this.revokeOrbKeys(orbId, headers, signal);
      if (revoked.isErr()) return err(revoked.error);
      const response = await this.post(
        this.url("/api/v2/tailnet/-/keys"),
        headers,
        JSON.stringify({
          description: `pi-orb ${orbId} i${incarnation}`,
          expirySeconds: KEY_EXPIRY_SECONDS,
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: false,
                preauthorized: true,
                tags: [TAILSCALE_ORB_TAG],
              },
            },
          },
        }),
        signal,
      );
      if (response.isErr()) return err(response.error);
      if (response.value.status < 200 || response.value.status >= 300) {
        return err(statusError("tailscale key create", response.value.status, response.value.text));
      }
      const body = parseJson("tailscale key create", response.value.text);
      if (body.isErr()) return err(body.error);
      const key = body.value["key"];
      if (typeof key !== "string" || key === "") {
        return err(rejected("tailscale key create response has no key"));
      }
      return ok(key);
    };
    return new ResultAsync(this.withOrbLock(orbId, run));
  }
}
