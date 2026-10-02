export interface McpError {
  readonly type: "mcp_error";
  readonly code: "cancelled" | "unavailable" | "invalid" | "auth_required";
  readonly message: string;
}

export const mcpError = (code: McpError["code"], message: string): McpError => ({
  type: "mcp_error",
  code,
  message,
});
