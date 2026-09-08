export const HOSTED_FILE_MAX_BYTES = 32 * 1024 * 1024;

export interface HostedObjectRef {
  readonly key: string;
  readonly generation: string;
}

export interface StoredHostedObject {
  readonly ref: HostedObjectRef;
  readonly size: number;
  readonly sha256: string;
}

export interface HostedFile {
  readonly orbId: string;
  readonly path: string;
  readonly object: HostedObjectRef;
  readonly size: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface HostingUploadRequest {
  readonly orbId: string;
  readonly runtimeTokenHash: string;
  readonly incarnation: number;
  readonly requestId: string;
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
  readonly sha256: string;
}

export interface HostingOperation {
  readonly id: string;
  readonly request: HostingUploadRequest;
  readonly state: "reserved" | "uploading" | "published";
  readonly publishedFile: HostedFile | null;
}

export interface HostingAttempt {
  readonly id: string;
  readonly operationId: string;
  readonly objectKey: string;
  readonly epoch: number;
  readonly state: "beginning" | "session_ready" | "committed";
  readonly sessionId: string | null;
  readonly committedObject: StoredHostedObject | null;
}

export interface HostingCleanupItem {
  readonly id: string;
  readonly orbId: string;
  readonly path: string | null;
  readonly sessionId: string | null;
  readonly object: HostedObjectRef | null;
}

export interface HostedFileInventory {
  readonly files: HostedFile[];
  readonly cleanupIssues: readonly {
    readonly path: string | null;
    readonly lastError: string;
    readonly lastErrorAt: number;
  }[];
}

export interface HostingCleanupClaim extends HostingCleanupItem {
  readonly epoch: number;
}

export type HostingError =
  | { readonly type: "hosting_invalid"; readonly message: string }
  | { readonly type: "hosting_not_found"; readonly message: string }
  | { readonly type: "hosting_too_large"; readonly message: string }
  | { readonly type: "hosting_unauthorized"; readonly message: string }
  | { readonly type: "hosting_conflict"; readonly message: string }
  | { readonly type: "hosting_retryable"; readonly message: string }
  | { readonly type: "hosting_cancelled"; readonly message: string }
  | { readonly type: "hosting_corruption"; readonly message: string };
