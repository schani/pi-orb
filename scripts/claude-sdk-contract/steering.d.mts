export interface SteeringProbeResult {
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

export function probeSteering(mode: "tool" | "response"): Promise<SteeringProbeResult>;
