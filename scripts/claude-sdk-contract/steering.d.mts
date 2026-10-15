export interface SteeringProbeResult {
  readonly requests: number;
  readonly nativeReceipt: "queued_command" | "user";
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
  mode: "tool" | "response",
  options?: {
    readonly onRoot?: (context: {
      readonly home: string;
      readonly rootPath: string;
      readonly sessionId: string;
      readonly firstUuid: string;
      readonly steerUuid: string;
    }) => Promise<void> | void;
  },
): Promise<SteeringProbeResult>;
