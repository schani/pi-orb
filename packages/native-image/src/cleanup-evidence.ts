import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { okAsync, ResultAsync } from "neverthrow";

const execFileAsync = promisify(execFile);

export type CleanupEvidenceStatus = "absent" | "submitted" | "succeeded" | "failed" | "uncertain";
export interface CleanupEvidence {
  readonly resourceKind: "instances" | "disks" | "images";
  readonly target: string;
  readonly scope: string;
  readonly operation: string | null;
  readonly status: CleanupEvidenceStatus;
  readonly errorCode: string | null;
}
export interface CleanupEvidenceError {
  readonly type: "cleanup_evidence_write_failed";
  readonly message: string;
}
export type CleanupEvidenceWriter = (
  evidence: CleanupEvidence,
) => ResultAsync<void, CleanupEvidenceError>;
export type CleanupEvidencePublisher = (releaseRecord: string, path: string) => Promise<void>;

const publishCleanupEvidence: CleanupEvidencePublisher = async (releaseRecord, path) => {
  await execFileAsync("python3", [
    "-m",
    "infra.release_state",
    "native-cleanup",
    releaseRecord,
    path,
  ]);
};

export function fileCleanupEvidenceWriter(
  path: string,
  releaseRecord?: string,
  publish: CleanupEvidencePublisher = publishCleanupEvidence,
): CleanupEvidenceWriter {
  const entries = new Map<string, CleanupEvidence>();
  return (evidence) => {
    entries.set(evidence.target, evidence);
    const temporary = `${path}.next`;
    return ResultAsync.fromPromise(
      mkdir(dirname(path), { recursive: true })
        .then(() =>
          writeFile(temporary, `${JSON.stringify([...entries.values()], null, 2)}\n`, {
            mode: 0o600,
          }),
        )
        .then(() => rename(temporary, path)),
      (): CleanupEvidenceError => ({
        type: "cleanup_evidence_write_failed",
        message: "cannot persist native cleanup evidence",
      }),
    ).andThen(() =>
      releaseRecord === undefined
        ? okAsync(undefined)
        : ResultAsync.fromPromise(
            Promise.resolve().then(() => publish(releaseRecord, path)),
            (): CleanupEvidenceError => ({
              type: "cleanup_evidence_write_failed",
              message: "cannot publish native cleanup evidence",
            }),
          ),
    );
  };
}
