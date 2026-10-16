import { existsSync } from "node:fs";

export interface SessionFileSource {
  getSessionFile(): string | null | undefined;
}

/**
 * Whether the SDK has durably persisted the session (docs/history-replication.md). A bare
 * `SessionManager.create` writes its file only on the first user or assistant
 * message (session-flush.contract.test.ts); setup entries before that are
 * memory-only and must never be served to the control plane — a committed
 * cursor naming one would be unresolvable after a restart. Production sessions
 * are created by `createPersistentSession` (settings-persistence.ts), which
 * writes the file eagerly, so the gate passes from creation there. Observing
 * file existence (rather than mirroring the SDK's internal heuristic) keeps the
 * gate correct if the SDK changes when it flushes.
 */
export function sessionFlushed(manager: SessionFileSource): boolean {
  const file = manager.getSessionFile();
  return typeof file === "string" && file !== "" && existsSync(file);
}
