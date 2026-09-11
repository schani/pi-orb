import { MCP_RUNTIME_PATH, McpOAuthErrorSchema, McpOAuthGrantSchema } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { type McpError, mcpError } from "./service.ts";

export interface McpAccessGrant {
  accessToken: string;
  expiresAt: number;
  generation: number;
}
export interface McpTokenEndpoint {
  request(
    task: SimulationTask,
    signal: AbortSignal,
    rejectedGeneration?: number,
  ): Promise<Result<McpAccessGrant, McpError>>;
}
/** Per-connection cache; fences late token responses, including SDK background stream requests. */
export class McpCredentialResolver {
  private grant: McpAccessGrant | null = null;
  private rejectedGeneration: number | undefined;
  private attemptedRecovery = false;
  private blockedGeneration: number | undefined;
  private readonly endpoint: McpTokenEndpoint;
  constructor(endpoint: McpTokenEndpoint) {
    this.endpoint = endpoint;
  }
  async resolve(
    task: SimulationTask,
    signal: AbortSignal,
  ): Promise<Result<McpAccessGrant, McpError>> {
    await task.checkpoint("mcp:credential-resolution");
    if (signal.aborted) return err(mcpError("cancelled", "MCP request cancelled"));
    if (
      this.grant &&
      this.rejectedGeneration === undefined &&
      this.blockedGeneration === undefined &&
      this.grant.expiresAt > task.wallNow() + 30_000
    )
      return ok(this.grant);
    const rejected = this.rejectedGeneration;
    const token = await this.endpoint.request(task, signal, rejected);
    if (token.isErr()) return token;
    if (signal.aborted) return err(mcpError("cancelled", "MCP request cancelled"));
    if (this.grant && token.value.generation < this.grant.generation) {
      return this.grant.expiresAt > task.wallNow()
        ? ok(this.grant)
        : err(mcpError("unavailable", "MCP credential changed; retry explicitly"));
    }
    if (this.rejectedGeneration !== undefined && token.value.generation <= this.rejectedGeneration)
      return err(mcpError("unavailable", "MCP authorization was rejected; retry explicitly"));
    if (this.blockedGeneration !== undefined && token.value.generation <= this.blockedGeneration)
      return err(
        mcpError("unavailable", "MCP authorization required; reconnect in project MCP settings"),
      );
    if (this.blockedGeneration !== undefined) this.attemptedRecovery = false;
    this.blockedGeneration = undefined;
    this.rejectedGeneration = undefined;
    this.attemptedRecovery ||= rejected !== undefined;
    this.grant = token.value;
    return ok(token.value);
  }
  rejected(generation: number) {
    if (this.grant?.generation !== generation) return;
    if (this.attemptedRecovery) this.blockedGeneration = generation;
    else this.rejectedGeneration = generation;
    this.grant = null;
  }
  accepted() {
    this.attemptedRecovery = false;
  }
}
export class HttpMcpTokenEndpoint implements McpTokenEndpoint {
  private readonly env: BrokerEnv;
  private readonly id: string;
  private readonly url: string;
  constructor(env: BrokerEnv, id: string, url: string) {
    this.env = env;
    this.id = id;
    this.url = url;
  }
  async request(
    _task: SimulationTask,
    signal: AbortSignal,
    rejectedGeneration?: number,
  ): Promise<Result<McpAccessGrant, McpError>> {
    const response = await ResultAsync.fromPromise(
      fetch(`${this.env.controlPlaneUrl}${MCP_RUNTIME_PATH}/${this.id}/token`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: this.url,
          ...(rejectedGeneration === undefined ? {} : { rejectedGeneration }),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        redirect: "error",
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as unknown,
      })),
      () => mcpError("unavailable", "MCP token broker unavailable"),
    );
    if (response.isErr()) return err(response.error);
    if (Check(McpOAuthErrorSchema, response.value.body))
      return err(mcpError("unavailable", response.value.body.error.message));
    if (response.value.status !== 200 || !Check(McpOAuthGrantSchema, response.value.body))
      return err(
        mcpError(
          "unavailable",
          response.value.status === 401
            ? "MCP authorization required; reconnect in project MCP settings"
            : "MCP token unavailable; check project MCP settings",
        ),
      );
    return ok(response.value.body);
  }
}
