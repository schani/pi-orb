import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { HistoryFiles } from "./history.ts";

export interface WorkflowChildTerminal {
  readonly runId: string;
  readonly key: string;
  readonly agentId: string;
}
export interface WorkflowJournalError {
  readonly type: "claude_workflow_journal_error";
  readonly reason: "io" | "invalid";
  readonly message: string;
}
export const workflowTerminalIdentity = (proof: WorkflowChildTerminal): string =>
  `${proof.runId}:${proof.key}:${proof.agentId}`;
const invalid = (): WorkflowJournalError => ({
  type: "claude_workflow_journal_error",
  reason: "invalid",
  message: "Invalid native Workflow journal.",
});
const io = (): WorkflowJournalError => ({
  type: "claude_workflow_journal_error",
  reason: "io",
  message: "Cannot read or sync native Workflow journals.",
});
const agentId = /^[\w-]{1,128}$/;

/** rootPath comes from findNativeClaudeTranscript; only bounded identities leave this adapter. */
export function readWorkflowChildTerminals(
  rootPath: string,
  ownedIds: readonly string[],
  files: HistoryFiles,
): Result<readonly WorkflowChildTerminal[], WorkflowJournalError> {
  const directory = join(dirname(rootPath), basename(rootPath, ".jsonl"), "subagents", "workflows");
  const runs = Result.fromThrowable(
    () =>
      existsSync(directory)
        ? readdirSync(directory, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [],
    io,
  )();
  if (runs.isErr()) return err(runs.error);
  const owned = new Set(ownedIds);
  const results = new Map<string, WorkflowChildTerminal>();
  for (const runId of runs.value.sort()) {
    if (!/^wf_[\w-]{1,128}$/.test(runId)) return err(invalid());
    const path = join(directory, runId, "journal.jsonl");
    const read = Result.fromThrowable(() => files.read(path), io)();
    if (read.isErr()) return err(read.error);
    if (read.value === null) continue;
    const before = results.size;
    // Native appends are concurrent; the unfinished tail is not evidence.
    for (const line of read.value.split("\n").slice(0, -1)) {
      if (line.trim() === "") continue;
      const parsed = Result.fromThrowable(() => JSON.parse(line) as unknown, invalid)();
      if (parsed.isErr()) return err(parsed.error);
      if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value))
        return err(invalid());
      const record = parsed.value as Record<string, unknown>;
      if (record.type !== "result" || !owned.has(record.agentId as string)) continue;
      if (
        typeof record.agentId !== "string" ||
        !agentId.test(record.agentId) ||
        typeof record.key !== "string" ||
        !/^v\d{1,8}:[0-9a-f]{64}$/.test(record.key) ||
        !Object.hasOwn(record, "result") ||
        record.result === null
      )
        return err(invalid());
      const proof = { runId, key: record.key, agentId: record.agentId };
      results.set(workflowTerminalIdentity(proof), proof);
    }
    if (results.size === before) continue;
    const synced = Result.fromThrowable(() => files.sync(path), io)();
    if (synced.isErr()) return err(synced.error);
  }
  return ok([...results.values()]);
}
