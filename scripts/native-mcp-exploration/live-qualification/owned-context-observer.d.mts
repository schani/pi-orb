import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
export declare function successfulAssistant(
  message: { role?: string; provider?: string; model?: string; stopReason?: string } | undefined,
): boolean;
export declare function qualifiesMeasurement(
  record: {
    profile: string;
    phase: string;
    kind: string;
    status: string;
    modelVerified: boolean;
    codemodeActive: boolean;
    discovered: Record<string, number>;
    searched: Record<string, number>;
    deniedCalls: number;
  },
  profile: string,
  phase: string,
): boolean;
declare const observer: ExtensionFactory;
export default observer;
