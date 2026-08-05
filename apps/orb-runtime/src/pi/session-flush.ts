import { existsSync } from "node:fs";

/** The one SessionManager capability the flush gate needs. */
export interface SessionFileSource {
  getSessionFile(): string | null | undefined;
}

/**
 * Whether the SDK has durably persisted the session (docs/history-replication.md). The
 * pinned SessionManager writes its file only once the first assistant
 * message exists (session-flush.contract.test.ts); before that, entries are
 * memory-only and must never be served to the control plane — a committed
 * cursor naming one would be unresolvable after a restart. Observing file
 * existence (rather than mirroring the SDK's internal heuristic) makes the
 * gate a no-op if a future SDK flushes eagerly.
 */
export function sessionFlushed(manager: SessionFileSource): boolean {
  const file = manager.getSessionFile();
  return typeof file === "string" && file !== "" && existsSync(file);
}
