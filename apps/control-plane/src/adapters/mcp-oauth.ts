import { lookup } from "node:dns";
import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationFull,
  type OAuthTokens,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";
import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import { Agent } from "undici";
import {
  type McpOAuthBinding,
  type McpOAuthProtocol,
  oauthError,
  type StoredMcpOAuth,
} from "../domain/mcp-oauth.ts";
import { isPublicMcpAddress, validateMcpEndpoint } from "./mcp-probe.ts";

interface Context {
  issuer: string;
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInformationFull;
  resource: string;
  redirect: string;
  verifier: string;
}
/** Socket-time public address validation applies to every discovered URL, not just the MCP URL. */
export function createMcpOAuthFetch() {
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error || !addresses.length || addresses.some((a) => !isPublicMcpAddress(a.address))) {
            // Node DNS callback requires Error; confined to the network adapter.
            callback(new Error("OAuth DNS rejected"), "", 4);
            return;
          }
          if (options.all) callback(null, addresses);
          else {
            const first = addresses[0];
            if (first) callback(null, first.address, first.family);
          }
        });
      },
    },
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (validateMcpEndpoint(url).isErr())
      return Promise.reject(new Error("OAuth endpoint rejected"));
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      dispatcher: agent,
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(10_000),
      ]),
    } as RequestInit & { dispatcher: Agent });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return Promise.reject(new Error("OAuth response too large"));
        }
        chunks.push(part.value);
      }
    }
    return new Response(size ? Buffer.concat(chunks) : null, {
      status: response.status,
      headers: response.headers,
    });
  };
  return {
    fetcher,
    close: () => ResultAsync.fromPromise(agent.close(), () => oauthError("unavailable")),
  };
}

/** SDK exceptions end here; no raw response/error, code or token crosses this boundary. */
export class SdkMcpOAuth implements McpOAuthProtocol {
  private readonly redirect: string;
  private readonly fetcher: typeof fetch;
  private readonly browserEndpointAllowed: (url: string) => boolean;
  constructor(
    redirect: string,
    fetcher: typeof fetch,
    browserEndpointAllowed: (url: string) => boolean = (url) => validateMcpEndpoint(url).isOk(),
  ) {
    this.redirect = redirect;
    this.fetcher = fetcher;
    this.browserEndpointAllowed = browserEndpointAllowed;
  }
  private credential(
    task: SimulationTask,
    prior: StoredMcpOAuth,
    tokens: OAuthTokens,
  ): StoredMcpOAuth | null {
    // Unknown lifetime is explicitly unsupported rather than pretending the token is short-lived.
    if (
      !tokens.expires_in ||
      tokens.expires_in <= 0 ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.token_type.toLowerCase() !== "bearer"
    )
      return null;
    return {
      ...prior,
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? prior.refresh,
      expiresAt: task.wallNow() + tokens.expires_in * 1000,
    };
  }
  async prepare(task: SimulationTask, binding: McpOAuthBinding, state: string) {
    const result = await ResultAsync.fromPromise(
      (async () => {
        const info = await discoverOAuthServerInfo(binding.url, { fetchFn: this.fetcher });
        const metadata = info.authorizationServerMetadata;
        const resource = info.resourceMetadata?.resource;
        if (
          !metadata ||
          !resource ||
          !metadata.code_challenge_methods_supported?.includes("S256") ||
          !metadata.registration_endpoint
        )
          return null;
        const resourceUrl = new URL(resource);
        const serverUrl = new URL(binding.url);
        if (
          resourceUrl.origin !== serverUrl.origin ||
          !(
            serverUrl.pathname === resourceUrl.pathname ||
            serverUrl.pathname.startsWith(
              resourceUrl.pathname.endsWith("/")
                ? resourceUrl.pathname
                : `${resourceUrl.pathname}/`,
            )
          ) ||
          resourceUrl.search ||
          resourceUrl.hash
        )
          return null;
        if (!this.browserEndpointAllowed(metadata.authorization_endpoint)) return null;
        const scope =
          info.resourceMetadata?.scopes_supported?.join(" ") ??
          metadata.scopes_supported?.join(" ");
        const client = await registerClient(info.authorizationServerUrl, {
          metadata,
          clientMetadata: {
            client_name: "pi-orb",
            redirect_uris: [this.redirect],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
          ...(scope ? { scope } : {}),
          fetchFn: this.fetcher,
        });
        const started = await startAuthorization(info.authorizationServerUrl, {
          metadata,
          clientInformation: client,
          redirectUrl: this.redirect,
          state,
          resource: resourceUrl,
          ...(scope ? { scope } : {}),
        });
        const context: Context = {
          issuer: info.authorizationServerUrl,
          metadata,
          client,
          resource,
          redirect: this.redirect,
          verifier: started.codeVerifier,
        };
        const secret: StoredMcpOAuth = {
          projectId: binding.projectId,
          connectionId: binding.id,
          access: "",
          refresh: "",
          expiresAt: task.wallNow(),
          accountId: binding.id,
          oauth: { ...context },
        };
        return { url: started.authorizationUrl.toString(), secret };
      })(),
      () => oauthError("unavailable"),
    );
    return result.isErr()
      ? err(result.error)
      : result.value
        ? ok(result.value)
        : err(oauthError("invalid_request"));
  }
  async exchange(task: SimulationTask, secret: StoredMcpOAuth, code: string, issuer?: string) {
    const result = await ResultAsync.fromPromise(
      (async () => {
        const context = secret.oauth as unknown as Context;
        const tokens = await exchangeAuthorization(context.issuer, {
          metadata: context.metadata,
          clientInformation: context.client,
          authorizationCode: code,
          ...(issuer ? { iss: issuer } : {}),
          codeVerifier: context.verifier,
          redirectUri: context.redirect,
          resource: new URL(context.resource),
          fetchFn: this.fetcher,
        });
        return this.credential(task, { ...secret, oauth: { ...context, verifier: "" } }, tokens);
      })(),
      () => oauthError("auth_required"),
    );
    return result.isErr()
      ? err(result.error)
      : result.value
        ? ok(result.value)
        : err(oauthError("auth_required"));
  }
  readonly refresher: McpOAuthProtocol["refresher"] = {
    refresh: (task, credential, operation) =>
      ResultAsync.fromPromise(
        (async () => {
          const secret = credential as StoredMcpOAuth;
          if (!secret.refresh) return null;
          const context = secret.oauth as unknown as Context;
          const tokens = await refreshAuthorization(context.issuer, {
            metadata: context.metadata,
            clientInformation: context.client,
            refreshToken: secret.refresh,
            resource: new URL(context.resource),
            fetchFn: (input, init) => this.fetcher(input, { ...init, signal: operation.signal }),
          });
          return this.credential(task, secret, tokens);
        })(),
        (error) => {
          const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : "";
          return code === "invalid_grant" || code === "invalid_client"
            ? { type: "invalid_grant" as const, message: "MCP reauthorization required" }
            : { type: "upstream_transient" as const, message: "MCP OAuth refresh unavailable" };
        },
      ).andThen((value) =>
        value
          ? ok(value)
          : err({ type: "invalid_grant" as const, message: "MCP reauthorization required" }),
      ),
  };
}
