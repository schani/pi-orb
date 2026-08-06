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
  mintAuthKey(orbId: string, signal: AbortSignal): ResultAsync<string, TailscaleError>;
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
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  }): Promise<TailscaleHttpResponse>;
}

export class FetchTailscaleApiTransport implements TailscaleApiTransport {
  async request(args: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  }): Promise<TailscaleHttpResponse> {
    const response = await fetch(args.url, {
      method: "POST",
      headers: { ...args.headers },
      body: args.body,
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

export class HttpTailscaleAuthKeyMinter implements TailscaleAuthKeyMinter {
  private readonly transport: TailscaleApiTransport;
  private readonly config: TailscaleOAuthConfig;

  constructor(transport: TailscaleApiTransport, config: TailscaleOAuthConfig) {
    this.transport = transport;
    this.config = config;
  }

  private url(path: string): string {
    return `${this.config.baseUrl ?? REAL_API_BASE_URL}${path}`;
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

  /**
   * Reusable and non-ephemeral: tailscaled's state persists on the orb's data
   * volume, so the same key is replayed after a restart and the device record
   * must survive the offline stretches a stopped orb spends. Preauthorized
   * and tagged so no admin has to approve a node and the tailnet ACLs scope
   * what `tag:pi-orb` may reach.
   */
  mintAuthKey(orbId: string, signal: AbortSignal): ResultAsync<string, TailscaleError> {
    const run = async (): Promise<Result<string, TailscaleError>> => {
      const token = await this.accessToken(signal);
      if (token.isErr()) return err(token.error);
      const response = await this.post(
        this.url("/api/v2/tailnet/-/keys"),
        {
          authorization: `Bearer ${token.value}`,
          "content-type": "application/json",
        },
        JSON.stringify({
          description: `pi-orb ${orbId}`,
          expirySeconds: KEY_EXPIRY_SECONDS,
          capabilities: {
            devices: {
              create: {
                reusable: true,
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
    return new ResultAsync(run());
  }
}
