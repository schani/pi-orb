import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import type { HistoryFiles } from "./history.ts";
import { readWorkflowChildTerminals } from "./workflow-journal.ts";

const key = `v2:${"a".repeat(64)}`;
const proof = { runId: "wf_run", key, agentId: "child" };
const record = (fields: object = {}) => ({
  type: "result",
  key,
  agentId: "child",
  result: false,
  ...fields,
});
const lines = (...entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
it.each([
  [
    "payload shapes",
    lines(
      ...["", false, 0, [], { private: [null, "PRIVATE"] }].map((result) => record({ result })),
    ),
    [proof],
  ],
  ["standalone success overrides failed", lines(record({ type: "failed" }), record()), [proof]],
  [
    "unrelated",
    lines(record({ agentId: "other", result: null }), { type: "started" }, { type: "failed" }),
    [],
  ],
  ["missing payload", lines({ type: "result", key, agentId: "child" }), "invalid"],
  ["null payload", lines(record({ result: null })), "invalid"],
  ["malformed", '{"private":"PRIVATE"\n', "invalid"],
  ["partial tail", lines(record()).trimEnd(), []],
  ["invalid key", lines(record({ key: `v${"1".repeat(100)}:${"a".repeat(64)}` })), "invalid"],
  ["invalid owned ID", lines(record({ agentId: "../escape" })), "invalid"],
  ["invalid run path", lines(record()), "invalid"],
  ["read failure", lines(record()), "io"],
  ["fsync failure", lines(record()), "io"],
] as const)("%s stays private and scoped", (mode, text, expected) => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-reader-"));
  const workflows = join(dir, "session", "subagents", "workflows");
  const run = mode === "invalid run path" ? "not-a-run" : "wf_run";
  mkdirSync(join(workflows, run), { recursive: true });
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const synced: string[] = [];
  const fail = () => {
    throw new Error("PRIVATE");
  };
  const files: HistoryFiles = {
    read: () => text,
    sync: (path) => {
      synced.push(path);
    },
    commit: () => undefined,
  };
  if (mode === "read failure") files.read = fail;
  if (mode === "fsync failure") files.sync = fail;
  const result = readWorkflowChildTerminals(
    join(dir, "session.jsonl"),
    ["child", "../escape"],
    files,
  );
  if (typeof expected === "string")
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "claude_workflow_journal_error",
      reason: expected,
    });
  else {
    expect(result._unsafeUnwrap()).toEqual(expected);
    expect(synced).toEqual(expected.length ? [join(workflows, run, "journal.jsonl")] : []);
  }
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
