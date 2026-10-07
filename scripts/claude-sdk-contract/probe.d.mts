export interface Shape {
  type: string;
  subtype?: string;
  keys: string[];
  messageKeys?: string[];
}
export interface NativeCancellationResult {
  account: { tokenSource?: string; apiKeySource?: string; apiProvider?: string };
  requestCount: number;
  cancellation: {
    requested: boolean;
    accepted: boolean;
    drained: boolean;
    receipt: { still_queued: string[]; cancelled?: string[] } | undefined | null;
    queuedUuid?: string;
  };
  compaction: {
    hasSummary: boolean;
    providerRequests: number;
    ordinaryAssistantContinuation: boolean;
  };
}
export interface NativeProbeResult extends NativeCancellationResult {
  requestSettings: { model: string; effort: string | null }[];
  sessionId: string;
  submittedUuid: string;
  userUuid?: string;
  assistantUuids: string[];
  streamAssistantUuids: string[];
  toolResultUuids: string[];
  streamToolResultUuids: string[];
  toolOutput: unknown;
  rootFile: string;
  rootHasTrailingNewline: boolean;
  projectKeyMatchesCwd: boolean;
  sdkVersion: string;
  cliVersion: string;
  childFiles: string[];
  childAssistantUuids: string[];
  childNativeAssistantUuids: string[];
  rootContainsChildAssistant: boolean;
  effectiveModel: string;
  nativeEfforts: (string | null)[];
  result: { subtype: string; isError: boolean };
  compaction: NativeCancellationResult["compaction"] & {
    customInstructionsReachedProvider: boolean;
    statuses: { status: string | null; compactResult: string | null; hasCompactError: boolean }[];
    publicPartialEvents: number;
    boundaryContentIsSummary: boolean;
    commandEchoCount: number;
    summary: {
      type: string;
      isCompactSummary: boolean;
      isVisibleInTranscriptOnly: boolean;
      hasContent: boolean;
    } | null;
    prefixPreserved: boolean;
    hasBoundary: boolean;
    hasSummary: boolean;
    metadataKeys: string[];
    boundaryKeys: string[];
    summaryKeys: string[];
  };
  conversationShapes: Shape[];
  nativeShapes: Shape[];
  streamShapes: Shape[];
}
export interface NativeProbeOptions {
  withSubagent?: boolean;
  withCompact?: boolean;
  compactInstructions?: string;
  cancelAt?: "initialization" | "before-enqueue" | "before-dispatch" | "in-progress" | "queued";
  onRoot?: (context: {
    home: string;
    rootPath: string;
    sessionId: string;
    submittedUuid: string;
    compactUuid: string;
  }) => void | Promise<void>;
}
export function probeNativeSdk(
  options: NativeProbeOptions & { cancelAt: NonNullable<NativeProbeOptions["cancelAt"]> },
): Promise<NativeCancellationResult>;
export function probeNativeSdk(
  options?: NativeProbeOptions & { cancelAt?: never },
): Promise<NativeProbeResult>;
export function probeNetworkGuard(): Promise<{
  localAllowed: boolean;
  externalDenied: boolean;
  otherPortDenied: boolean;
  udpDenied: boolean;
}>;
