import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";

export interface McpError {
  readonly type: "mcp_error";
  readonly code: "closed" | "cancelled" | "unavailable" | "invalid" | "unsupported";
  readonly message: string;
}
export const mcpError = (code: McpError["code"], message: string): McpError => ({
  type: "mcp_error",
  code,
  message,
});
export type McpOperation =
  | { method: "catalog" }
  | { method: "tools/call"; name: string; arguments: Record<string, unknown> }
  | { method: "prompts/get"; name: string; arguments: Record<string, string> }
  | { method: "resources/read"; uri: string };
export interface McpSession {
  perform(
    task: SimulationTask,
    operation: McpOperation,
    signal: AbortSignal,
  ): Promise<Result<unknown, McpError>>;
  close(): Promise<Result<void, McpError>>;
}
export interface McpTransport {
  connect(task: SimulationTask, signal: AbortSignal): Promise<Result<McpSession, McpError>>;
}

/** One serialized owner per server. No background activity or tool-call replay. */
export class McpConnection {
  private session: McpSession | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private readonly stop = new AbortController();
  private closing: Promise<Result<void, McpError>> | null = null;

  private readonly task: SimulationTask;
  private readonly transport: McpTransport;
  constructor(task: SimulationTask, transport: McpTransport) {
    this.task = task;
    this.transport = transport;
  }

  perform(
    operation: McpOperation,
    signal?: AbortSignal,
    task: SimulationTask = this.task,
  ): Promise<Result<unknown, McpError>> {
    const run = async (): Promise<Result<unknown, McpError>> => {
      if (this.stopping) return err(mcpError("closed", "MCP connection is closed"));
      const combined = signal ? AbortSignal.any([this.stop.signal, signal]) : this.stop.signal;
      if (combined.aborted) return err(mcpError("cancelled", "MCP request cancelled"));
      await task.checkpoint("mcp:acquire");
      if (this.stopping || combined.aborted)
        return err(mcpError("cancelled", "MCP request cancelled"));
      if (!this.session) {
        const connected = await this.transport.connect(task, combined);
        if (connected.isErr()) return connected;
        this.session = connected.value;
      }
      if (combined.aborted) return err(mcpError("cancelled", "MCP request cancelled"));
      const result = await this.session.perform(task, operation, combined);
      await task.checkpoint("mcp:completion");
      if (result.isErr()) {
        await this.session.close();
        this.session = null;
      }
      return combined.aborted
        ? err(mcpError("cancelled", "MCP request cancelled; outcome may be unknown"))
        : result;
    };
    const result = this.tail.then(run);
    this.tail = result;
    return result;
  }

  close(): Promise<Result<void, McpError>> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.stop.abort();
    this.closing = this.tail.then(async () => {
      const session = this.session;
      this.session = null;
      return session ? session.close() : ok(undefined);
    });
    return this.closing;
  }
}
