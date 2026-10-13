import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
export function probeTaskHandoff(options: {
  cwd: string;
  configDir: string;
  sessionId: string;
  input: SDKUserMessage;
  release: "after-result" | "during-response";
  onMessage(message: SDKMessage): Promise<boolean>;
}): Promise<{
  requests: number;
  acknowledgments: number;
  closedAtAcknowledgment: boolean;
  rootActivityAfterClose: boolean;
}>;
