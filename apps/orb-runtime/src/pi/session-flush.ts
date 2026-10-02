import { existsSync } from "node:fs";

/** The one SessionManager capability the flush gate needs. */
export interface SessionFileSource {
  getSessionFile(): string | null | undefined;
}

/**
 * Whether the SDK has durably persisted the session (docs/history-replication.md). The
 * pinned SessionManager writes its file on the first user or assistant
 * message (session-flush.contract.test.ts); setup entries before that are
 * memory-only and must never be served to the control plane — a committed
 * cursor naming one would be unresolvable after a restart. Observing file
 * existence (rather than mirroring the SDK's internal heuristic) keeps the
 * gate correct if the SDK changes when it flushes.
 */
export function sessionFlushed(manager: SessionFileSource): boolean {
  const file = manager.getSessionFile();
  return typeof file === "string" && file !== "" && existsSync(file);
}
