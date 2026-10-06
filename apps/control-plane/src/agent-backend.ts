import { err, ok } from "neverthrow";
export type AgentBackend = "central-durable" | "host-pi";
export function agentBackend(value: string | undefined) {
  if (value === undefined || value === "central-durable")
    return ok<AgentBackend>("central-durable");
  if (value === "host-pi") return ok<AgentBackend>(value);
  return err({
    code: "invalid_agent_backend" as const,
    message: "PI_ORB_AGENT_BACKEND must be central-durable or host-pi",
  });
}
