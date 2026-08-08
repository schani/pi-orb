import { GoogleAuth } from "google-auth-library";

/**
 * Minimal transport over the Compute Engine v1 REST API. The provider is
 * written against this interface so its state machine is unit-testable with
 * a scripted fake; this implementation adds ADC auth and JSON plumbing.
 */

export interface GceResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface GceApiTransport {
  request(args: {
    readonly method: "GET" | "POST" | "DELETE";
    /** Path under https://compute.googleapis.com/compute/v1/. */
    readonly path: string;
    readonly body?: Record<string, unknown>;
    readonly signal: AbortSignal;
  }): Promise<GceResponse>;
}

export class RestGceApiTransport implements GceApiTransport {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  async request(args: {
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string;
    readonly body?: Record<string, unknown>;
    readonly signal: AbortSignal;
  }): Promise<GceResponse> {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    const response = await fetch(`https://compute.googleapis.com/compute/v1/${args.path}`, {
      method: args.method,
      headers: {
        authorization: `Bearer ${token.token ?? ""}`,
        "content-type": "application/json",
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      signal: args.signal,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body };
  }
}
