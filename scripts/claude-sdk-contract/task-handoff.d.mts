import type {
  Options,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
export function probeTaskHandoff(options: {
  cwd: string;
  configDir: string;
  sessionId: string;
  input: SDKUserMessage;
  release: "after-result" | "during-response";
  onMessage(message: SDKMessage): Promise<boolean>;
  terminalFailure?: boolean;
  spawnProcess?: Options["spawnClaudeCodeProcess"];
  onQuery?(query: {
    interrupt(options?: {
      cancelQueued?: boolean;
    }): Promise<SDKControlInterruptResponse | undefined>;
    requestShutdown(): void;
  }): void;
}): Promise<{
  requests: number;
  responses: number;
  continuationAborted: boolean;
  acknowledgments: number;
  closedAtAcknowledgment: boolean;
  rootActivityAfterClose: boolean;
  interruptions: number;
  interruptReceipt: SDKControlInterruptResponse | undefined;
  terminalNotifications: number;
  nativeExit: boolean;
  stdoutEOF: boolean;
  processGroupOwned: boolean;
  trace: Record<string, unknown>[];
  exitCode: number | null | undefined;
  exitSignal: string | null | undefined;
  capabilities: string[] | undefined;
  cliVersion: string | undefined;
  sdkVersion: string;
  iteratorError: unknown;
}>;
