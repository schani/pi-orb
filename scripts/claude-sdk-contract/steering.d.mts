export interface SteeringProbeResult {
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
