export interface Shape {
  type: string;
  subtype?: string;
  keys: string[];
  messageKeys?: string[];
}
export interface NativeProbeResult {
  account: { tokenSource?: string; apiKeySource?: string; apiProvider?: string };
  requestCount: number;
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
  compaction: {
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
export function probeNativeSdk(options?: {
  withSubagent?: boolean;
  withCompact?: boolean;
  onRoot?: (context: {
    home: string;
    rootPath: string;
    sessionId: string;
    submittedUuid: string;
  }) => void | Promise<void>;
}): Promise<NativeProbeResult>;
export function probeNetworkGuard(): Promise<{
  localAllowed: boolean;
  externalDenied: boolean;
  otherPortDenied: boolean;
  udpDenied: boolean;
}>;
