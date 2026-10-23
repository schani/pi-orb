import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface SteeringProbeResult {
  readonly events: readonly SDKMessage[];
  readonly root: {
    readonly source: string;
    readonly sessionId: string;
    readonly steerUuid: string;
  };
  readonly requests: number;
  readonly results: readonly {
    readonly subtype: string;
    readonly isError: boolean;
    readonly answersFirst: boolean;
    readonly answersSteer: boolean;
  }[];
  readonly steeredWhileToolBlocked: boolean;
  readonly toolCompleted: boolean;
}

export function probeSteering(
  mode: "tool" | "response" | "thinking" | "tool-thinking",
  onMessage?: (message: SDKMessage) => Promise<void>,
  nextInput?: (
    kind: "first" | "steer",
    context: { sessionId: string; marker: string },
  ) => Promise<SDKUserMessage>,
): Promise<SteeringProbeResult>;
