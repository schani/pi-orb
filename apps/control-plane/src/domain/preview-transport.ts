import type { PreviewError } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { Result, ResultAsync } from "neverthrow";
import type { OperationContext } from "./ports.ts";
import type { PreviewRoute } from "./preview.ts";

export type PreviewHeaders = readonly (readonly [string, string])[];
export interface PreviewByteSource {
  read(): Promise<Result<Uint8Array | null, PreviewError>>;
}
export interface PreviewHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: PreviewHeaders;
  readonly body: PreviewByteSource;
}
export interface PreviewHttpResponse {
  readonly status: number;
  readonly headers: PreviewHeaders;
  readonly body: PreviewByteSource;
  dispose(): void;
}
export interface PreviewFrame {
  readonly bytes: Uint8Array;
  readonly binary: boolean;
}
export interface PreviewSocket {
  readonly protocol: string;
  readonly closeInfo: { readonly code: number; readonly reason: string } | null;
  read(): Promise<Result<PreviewFrame | null, PreviewError>>;
  write(frame: PreviewFrame): Promise<Result<void, PreviewError>>;
  close(code?: number, reason?: string): void;
}
export interface PreviewRuntimeTransport {
  openHttp(
    task: SimulationTask,
    route: PreviewRoute,
    request: PreviewHttpRequest,
    context: OperationContext,
  ): ResultAsync<PreviewHttpResponse, PreviewError>;
  openWebSocket(
    task: SimulationTask,
    route: PreviewRoute,
    path: string,
    headers: PreviewHeaders,
    protocols: readonly string[],
    context: OperationContext,
  ): ResultAsync<PreviewSocket, PreviewError>;
}
