import type { HostedFilesResponse } from "@pi-orb/protocol";
import type { ApiError } from "../lib/api.ts";
import { describeApiError } from "../lib/api.ts";

function byteSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function safeUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function HostedFiles({
  inventory,
  error,
}: {
  inventory: HostedFilesResponse | null;
  error: ApiError | null;
}) {
  if (inventory === null && error === null) return null;
  if (inventory?.files.length === 0 && inventory.cleanupIssues.length === 0 && error === null)
    return null;
  const hasIssue = error !== null || (inventory?.cleanupIssues.length ?? 0) > 0;
  return (
    <details className="hosted-files" open={hasIssue}>
      <summary>files{inventory === null ? "" : ` (${inventory.files.length})`}</summary>
      {error !== null && <p className="error-text">{describeApiError(error)}</p>}
      {inventory?.files.map((file) => (
        <div className="hosted-file" key={file.path}>
          {safeUrl(file.url) ? <a href={file.url}>{file.path}</a> : <span>{file.path}</span>}
          <span className="muted">
            {byteSize(file.size)} · {new Date(file.updatedAt).toLocaleString()}
          </span>
        </div>
      ))}
      {inventory?.cleanupIssues.map((issue) => (
        <p className="error-text" key={`${issue.path ?? "*"}:${issue.lastErrorAt}`}>
          {issue.path === null ? "cleanup" : issue.path}: {issue.lastError}
        </p>
      ))}
    </details>
  );
}
