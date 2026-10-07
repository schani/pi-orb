import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export function probeNestedContinuation(options?: {
  closePolicy?: "after-final-result" | "first-result";
  resumeReviewer?: boolean;
  /** Historical public SDK mechanism qualification, not production policy. */
  hookNestedForeground?: boolean;
  productionPreToolUse?: HookCallback[];
  nestedBackground?: boolean | undefined;
  rootFanout?: boolean;
  releaseOrder?: "forward" | "reverse";
  projectAgent?: { name: "contract-leaf" | "general-purpose"; background: boolean };
}): Promise<{
  closePolicy: string;
  counts: { root: number; reviewer: number; leaf: number };
  reviewerResumed: boolean;
  rootSawFinal: boolean;
  rootAsyncAdmissions: number;
  nestedForegroundResults: number;
  nestedDenialResults: number;
  descendantNativeFiles: number;
  peerRequests: number;
  ordinaryToolResults: number;
  rootSynthesisRecords: number;
  reviewerSynthesisRecords: number;
  nestedCompletionsAtRoot: number;
  nestedCompletionsAtReviewer: number;
  events: Array<Record<string, unknown>>;
}>;
