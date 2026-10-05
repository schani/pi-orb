import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type HistoryRecord, OrbHistoryViewSchema, OrbTranscriptSchema } from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { mapPiEntry } from "../pi/mapping.ts";

type Failure = {
  kind: "arguments" | "read" | "format" | "recovery_guard" | "write";
  message: string;
};
type Native = Record<string, unknown>;
type Entry = { id: string; parentId: string | null; native: Native; position: number };
const usage =
  "usage: npm run diagnose:history -- --session <native.jsonl> --replica <transcript.json> [--json]\nRecovery: add --recover --offline --replica-state <full-sql.json> --backup-dir <new-external-directory> [--output <new-candidate.jsonl>]\nWithout --output recovery atomically replaces the offline session. --offline attests no runtime/writer or concurrent SQL changes. Diagnosis is read-only. Keep reports/backups outside the target workspace.";
const object = (value: unknown): value is Native =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (): Failure => ({ kind: "format", message: "invalid JSON (possibly truncated)" }),
);
const read = (path: string) =>
  ResultAsync.fromThrowable(
    () => readFile(path),
    (): Failure => ({ kind: "read", message: `cannot read ${path}` }),
  )().andThen((bytes) =>
    Result.fromThrowable(
      () => ({
        bytes,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      }),
      (): Failure => ({ kind: "format", message: `unsupported invalid UTF-8 in ${path}` }),
    )(),
  );

type Options = {
  session: string;
  replica: string;
  json: boolean;
  recover: boolean;
  offline: boolean;
  state: string | undefined;
  backup: string | undefined;
  output: string | undefined;
};
function args(argv: string[]): Result<Options, Failure> {
  const options = new Map<string, string>();
  let json = false;
  let recover = false;
  let offline = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--json" && !json) {
      json = true;
      continue;
    }
    if (key === "--recover" && !recover) {
      recover = true;
      continue;
    }
    if (key === "--offline" && !offline) {
      offline = true;
      continue;
    }
    const value = argv[i + 1];
    if (
      !key ||
      !["--session", "--replica", "--replica-state", "--backup-dir", "--output"].includes(
        key ?? "",
      ) ||
      options.has(key) ||
      !value ||
      value.startsWith("--")
    )
      return err({ kind: "arguments", message: usage });
    options.set(key, value);
    i++;
  }
  const session = options.get("--session");
  const replica = options.get("--replica");
  const state = options.get("--replica-state");
  const backup = options.get("--backup-dir");
  const output = options.get("--output");
  if (
    !session ||
    !replica ||
    (recover ? !offline || !state || !backup : offline || state || backup || output)
  )
    return err({ kind: "arguments", message: usage });
  return ok({ session, replica, json, recover, offline, state, backup, output });
}

// Object-key order is not a native JSON content difference. Array order is.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function index(entries: Entry[]) {
  const byId = new Map<string, Entry[]>();
  for (const entry of entries) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  return byId;
}
function graph(entries: Entry[]) {
  const byId = index(entries);
  const children = new Map<string | null, string[]>();
  for (const entry of entries)
    children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry.id]);
  return {
    duplicates: [...byId]
      .filter(([, rows]) => rows.length > 1)
      .map(([id, rows]) => ({ id, positions: rows.map((row) => row.position) })),
    roots: children.get(null) ?? [],
    missingParents: entries
      .filter((entry) => entry.parentId !== null && !byId.has(entry.parentId))
      .map((entry) => ({ id: entry.id, parentId: entry.parentId })),
    forwardOrSelfParents: entries
      .filter(
        (entry) =>
          entry.parentId !== null &&
          (byId.get(entry.parentId)?.some((parent) => parent.position >= entry.position) ?? false),
      )
      .map((entry) => ({ id: entry.id, parentId: entry.parentId })),
    branches: [...children]
      .filter(([, ids]) => ids.length > 1)
      .map(([parentId, ids]) => ({ parentId, ids })),
    leaves: entries.filter((entry) => !children.has(entry.id)).map((entry) => entry.id),
  };
}
const describe = (entry: Entry) => ({
  id: entry.id,
  parentId: entry.parentId,
  position: entry.position,
  type: typeof entry.native.type === "string" ? entry.native.type : null,
  ...(typeof entry.native.customType === "string" ? { customType: entry.native.customType } : {}),
  timestamp: typeof entry.native.timestamp === "string" ? entry.native.timestamp : null,
});

function diagnose(sessionText: string, replicaText: string) {
  const parsed = parseJson(replicaText);
  if (parsed.isErr()) return err(parsed.error);
  const snapshot = parsed.value;
  if (!Check(OrbTranscriptSchema, snapshot) && !Check(OrbHistoryViewSchema, snapshot))
    return err<never, Failure>({
      kind: "format",
      message:
        "replica must be a complete native pi-orb transcript --json export (browser display history is not supported)",
    });
  const issues: { line: number; kind: string }[] = [];
  const headers: { line: number; native: Native }[] = [];
  const disk: Entry[] = [];
  const lines = sessionText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === "") continue;
    if (i === lines.length - 1) issues.push({ line: i + 1, kind: "unterminated" });
    const row = parseJson(lines[i] ?? "");
    if (row.isErr() || !object(row.value)) {
      issues.push({ line: i + 1, kind: "malformed_json_object" });
      continue;
    }
    const native = row.value;
    if (native.type === "session") {
      headers.push({ line: i + 1, native });
      continue;
    }
    if (
      typeof native.id !== "string" ||
      native.id === "" ||
      (native.parentId !== null && typeof native.parentId !== "string") ||
      typeof native.type !== "string" ||
      typeof native.timestamp !== "string"
    ) {
      issues.push({ line: i + 1, kind: "invalid_entry_identity" });
      continue;
    }
    disk.push({ id: native.id, parentId: native.parentId, native, position: i + 1 });
  }
  if (headers.length === 1 && headers[0]?.native.version !== 3)
    return err<never, Failure>({
      kind: "format",
      message:
        "unsupported native Pi session version; only version 3 is supported, no migration is performed",
    });
  const replica: Entry[] = [];
  const unavailableNative: string[] = [];
  const replicaIdentityMismatches: string[] = [];
  snapshot.records.forEach((record: HistoryRecord, i: number) => {
    const native = record.overflow.native;
    if (!object(native)) unavailableNative.push(record.id);
    else if (
      native.id !== record.id ||
      native.parentId !== record.parentId ||
      native.timestamp !== record.timestamp
    )
      replicaIdentityMismatches.push(record.id);
    replica.push({
      id: record.id,
      parentId: record.parentId,
      native: object(native) ? native : {},
      position: i + 1,
    });
  });
  const local = index(disk);
  const remote = index(replica);
  const diskOnly = disk.filter((entry) => !remote.has(entry.id)).map(describe);
  const replicaOnly = replica.filter((entry) => !local.has(entry.id)).map(describe);
  const divergences: string[] = [];
  const comparisonUnavailable: string[] = [];
  const projected: string[] = [];
  for (const entry of disk) {
    const rows = remote.get(entry.id);
    if (!rows) continue;
    if (
      rows.length !== 1 ||
      local.get(entry.id)?.length !== 1 ||
      unavailableNative.includes(entry.id)
    ) {
      comparisonUnavailable.push(entry.id);
      continue;
    }
    // Reuse the production projection: system state and Codex diagnostics are intentionally sanitized.
    const mapping = Result.fromThrowable(
      () => mapPiEntry(entry.native),
      (): Failure => ({ kind: "format", message: "native mapping failed" }),
    )();
    if (mapping.isErr() || mapping.value.isErr()) {
      comparisonUnavailable.push(entry.id);
      continue;
    }
    const mapped = mapping.value.value;
    if (canonical(mapped.overflow.native) !== canonical(entry.native)) projected.push(entry.id);
    const record = snapshot.records[(rows[0]?.position ?? 0) - 1];
    if (canonical(mapped) !== canonical(record)) divergences.push(entry.id);
  }
  let sharedPrefix = 0;
  while (
    sharedPrefix < disk.length &&
    sharedPrefix < replica.length &&
    disk[sharedPrefix]?.id === replica[sharedPrefix]?.id
  )
    sharedPrefix++;
  // Compare the exported selected chain with disk ancestry, not the whole append log.
  const ancestry: string[] = [];
  const ancestrySeen = new Set<string>();
  let ancestor = snapshot.cursor;
  let ancestryProblem: string | null = null;
  while (ancestor !== null) {
    const rows = local.get(ancestor);
    if (ancestrySeen.has(ancestor)) {
      ancestryProblem = `cycle at ${ancestor}`;
      break;
    }
    if (rows?.length !== 1) {
      ancestryProblem = `missing or duplicate ancestor ${ancestor}`;
      break;
    }
    const row = rows[0];
    if (!row) break;
    ancestrySeen.add(ancestor);
    ancestry.push(ancestor);
    ancestor = row.parentId;
  }
  ancestry.reverse();
  const localGraph = graph(disk);
  const replicaGraph = graph(replica);
  const header = headers.length === 1 ? headers[0]?.native : undefined;
  const replicaHeader = snapshot.session?.overflow.native;
  const warnings = [
    "Files are observations, not an atomic live snapshot. Replica may lag. No repair or rollback safety is established.",
    "Replica export order follows the selected parent chain; it does not prove original append order or include all stored branches.",
  ];
  if (issues.length)
    warnings.push(
      "Malformed/unterminated lines: absence means absent from parseable records, not proof bytes never reached disk.",
    );
  if (headers.length !== 1 || headers[0]?.line !== 1 || !header || typeof header.id !== "string")
    warnings.push("Native session must have exactly one valid header at line 1.");
  if (snapshot.session === null || !object(replicaHeader))
    warnings.push("Replica native session header unavailable; header comparison incomplete.");
  if (comparisonUnavailable.length || unavailableNative.length)
    warnings.push(
      "Some payload comparisons are unavailable; equality is not established for those IDs.",
    );
  if (ancestryProblem) warnings.push(`Selected-chain comparison incomplete: ${ancestryProblem}.`);
  if (header && snapshot.session && header.id !== snapshot.session.id)
    warnings.push(
      "Session identity mismatch: record-ID coincidences do not establish a shared session.",
    );
  if (snapshot.records.at(-1)?.id !== (snapshot.cursor ?? undefined))
    warnings.push("Export does not end at its cursor; it may be incomplete or inconsistent.");
  if (
    [localGraph, replicaGraph].some(
      (g) =>
        g.duplicates.length ||
        g.missingParents.length ||
        g.forwardOrSelfParents.length ||
        g.branches.length ||
        g.roots.length > 1,
    )
  )
    warnings.push(
      "Graph is ambiguous or incomplete; inspect duplicate IDs, roots, parents and branches before interpreting order.",
    );
  const report = {
    readOnly: true,
    replicaOrbId: "orbId" in snapshot ? snapshot.orbId : snapshot.orb.id,
    counts: { disk: disk.length, replica: replica.length },
    headers: {
      diskLines: headers.map((h) => h.line),
      diskSessionId: typeof header?.id === "string" ? header.id : null,
      replicaSessionId: snapshot.session?.id ?? null,
      identityMatches: header && snapshot.session ? header.id === snapshot.session.id : null,
      nativeMatches:
        header && object(replicaHeader) ? canonical(header) === canonical(replicaHeader) : null,
      replicaIdentityMatchesNative:
        object(replicaHeader) && snapshot.session ? replicaHeader.id === snapshot.session.id : null,
    },
    jsonlIssues: issues,
    diskOnly,
    replicaOnly,
    contentDivergenceIds: divergences,
    comparisonUnavailableIds: [...new Set(comparisonUnavailable)],
    intentionallyProjectedIds: projected,
    replicaNativeUnavailableIds: unavailableNative,
    replicaIdentityMismatchIds: replicaIdentityMismatches,
    order: {
      appendVsExportSharedIdPrefixLength: sharedPrefix,
      firstDiskAfterPrefix: disk[sharedPrefix]?.id ?? null,
      firstReplicaAfterPrefix: replica[sharedPrefix]?.id ?? null,
      diskLastParseableId: disk.at(-1)?.id ?? null,
      diskAncestryAtReplicaCursor: ancestry,
      ancestryProblem,
      selectedChainIdsMatch:
        ancestryProblem === null
          ? canonical(ancestry) === canonical(replica.map((entry) => entry.id))
          : null,
    },
    graphs: { disk: localGraph, replica: replicaGraph },
    replicaPointers: ["cursor", "headId"].map((key) => {
      const id = key === "cursor" ? snapshot.cursor : snapshot.headId;
      return {
        key,
        id,
        presentLocally: id === null ? null : local.has(id),
        presentInExport: id === null ? null : remote.has(id),
      };
    }),
    warnings,
  };
  return ok(report);
}

const fingerprint = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const refuse = (message: string): Result<never, Failure> =>
  err({ kind: "recovery_guard", message });
const io = <T>(message: string, operation: () => Promise<T>) =>
  ResultAsync.fromThrowable(operation, (): Failure => ({ kind: "write", message }))();
const mapped = (native: Native) =>
  Result.fromThrowable(
    () => mapPiEntry(native),
    (): Failure => ({ kind: "recovery_guard", message: "native_mapping_failed" }),
  )().andThen((result) =>
    result.mapErr((): Failure => ({ kind: "recovery_guard", message: "native_mapping_failed" })),
  );

// Accept only a JSON object truncated inside a string, with every complete value
// equal to the replica and the final string a prefix. Never infer arbitrary garbage.
function truncatedPrefix(raw: string, native: Native): boolean {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return false;
    }
  }
  if (!quoted || escaped || !stack.length) return false;
  const partial = parseJson(`${raw}"${stack.reverse().join("")}`);
  if (partial.isErr() || !object(partial.value)) return false;
  const prefix = (left: unknown, right: unknown): boolean => {
    if (typeof left === "string" && typeof right === "string") return right.startsWith(left);
    if (Array.isArray(left) && Array.isArray(right))
      return (
        left.length > 0 &&
        left.length <= right.length &&
        left.every((value, i) =>
          i === left.length - 1
            ? prefix(value, right[i])
            : canonical(value) === canonical(right[i]),
        )
      );
    if (object(left) && object(right)) {
      const keys = Object.keys(left);
      return (
        keys.length > 0 &&
        keys.every(
          (key, i) =>
            Object.hasOwn(right, key) &&
            (i === keys.length - 1
              ? prefix(left[key], right[key])
              : canonical(left[key]) === canonical(right[key])),
        )
      );
    }
    return false;
  };
  return (
    partial.value.type === native.type &&
    partial.value.id === native.id &&
    partial.value.parentId === native.parentId &&
    partial.value.timestamp === native.timestamp &&
    prefix(partial.value, native)
  );
}

function recoveryPlan(sessionText: string, replicaText: string, proofText: string) {
  const diagnosis = diagnose(sessionText, replicaText);
  const remote = parseJson(replicaText);
  const proof = parseJson(proofText);
  if (diagnosis.isErr()) return err(diagnosis.error);
  if (remote.isErr()) return err(remote.error);
  if (proof.isErr()) return err(proof.error);
  if (!Check(OrbTranscriptSchema, remote.value) && !Check(OrbHistoryViewSchema, remote.value))
    return refuse("unsupported_replica");
  const snapshot = remote.value;
  const sql = proof.value;
  const orbId = "orbId" in snapshot ? snapshot.orbId : snapshot.orb.id;
  if (!object(sql) || sql.version !== 1 || !Array.isArray(sql.records))
    return refuse("sql_proof_unsupported_shape");
  if (sql.complete !== true) return refuse("sql_proof_not_attested_complete");
  if (!Number.isSafeInteger(sql.rowCount) || sql.rowCount !== sql.records.length)
    return refuse("sql_proof_row_count_mismatch");
  if ((sql.state !== "stopped" && sql.state !== "failed") || sql.hostRef !== null)
    return refuse("sql_proof_target_not_offline");
  if (
    sql.orbId !== orbId ||
    sql.cursor !== snapshot.cursor ||
    sql.headId !== snapshot.headId ||
    canonical(sql.session) !== canonical(snapshot.session)
  )
    return refuse("sql_proof_identity_or_pointers_mismatch");
  const allSql = new Map<string, unknown>();
  for (const record of sql.records) {
    if (!object(record) || typeof record.id !== "string" || allSql.has(record.id))
      return refuse("sql_proof_invalid_or_duplicate_record");
    allSql.set(record.id, record);
  }
  const report = diagnosis.value;
  if (
    report.headers.diskLines.length !== 1 ||
    report.headers.diskLines[0] !== 1 ||
    !report.headers.identityMatches ||
    !report.headers.nativeMatches ||
    !report.headers.replicaIdentityMatchesNative ||
    report.contentDivergenceIds.length ||
    report.comparisonUnavailableIds.length ||
    report.replicaNativeUnavailableIds.length ||
    report.replicaIdentityMismatchIds.length
  )
    return refuse("header_identity_or_common_payload_mismatch");
  if (
    allSql.size !== snapshot.records.length ||
    snapshot.records.some((record) => canonical(allSql.get(record.id)) !== canonical(record))
  )
    return refuse("sql_proof_extra_branch_or_snapshot_payload_mismatch");
  const linear = (entries: { id: string; parentId: string | null }[]) => {
    const seen = new Set<string>();
    return entries.every((entry, i) => {
      const valid = !seen.has(entry.id) && entry.parentId === (entries[i - 1]?.id ?? null);
      seen.add(entry.id);
      return valid;
    });
  };
  if (
    !linear(snapshot.records) ||
    !snapshot.cursor ||
    snapshot.cursor !== snapshot.headId ||
    snapshot.records.at(-1)?.id !== snapshot.cursor
  )
    return refuse("replica_not_single_complete_linear_chain");
  const lines = sessionText.split("\n");
  const prefixCount = report.order.appendVsExportSharedIdPrefixLength;
  if (
    !sessionText.endsWith("\n") ||
    prefixCount < 1 ||
    report.jsonlIssues.length !== 1 ||
    report.jsonlIssues[0]?.kind !== "malformed_json_object" ||
    report.jsonlIssues[0]?.line !== prefixCount + 2
  )
    return refuse("unsupported_malformed_line_or_fork_position");
  const restored = snapshot.records.slice(prefixCount);
  if (!restored.length || report.replicaOnly.length !== restored.length)
    return refuse("unsupported_replica_tail");
  const local: Native[] = [];
  for (const raw of lines.slice(prefixCount + 2, -1)) {
    const parsed = parseJson(raw);
    if (parsed.isErr() || !object(parsed.value)) return refuse("unexplained_local_tail_bytes");
    local.push(parsed.value);
  }
  if (
    !local.length ||
    local.length !== report.diskOnly.length ||
    local.some(
      (entry, i) =>
        typeof entry.id !== "string" ||
        allSql.has(entry.id) ||
        entry.id !== report.diskOnly[i]?.id ||
        entry.parentId !== (i === 0 ? snapshot.records[prefixCount - 1]?.id : local[i - 1]?.id),
    )
  )
    return refuse("local_tail_registered_in_sql_or_not_linear_fork");
  if (new Set(local.map((entry) => entry.id)).size !== local.length)
    return refuse("duplicate_local_tail_id");
  for (const record of restored) {
    const native = record.overflow.native;
    if (
      !object(native) ||
      (native.type !== "message" && native.type !== "custom_message") ||
      (native.type === "message" &&
        (!object(native.message) ||
          !["user", "assistant", "toolResult"].includes(String(native.message.role))))
    )
      return refuse("restored_native_type_not_losslessly_reconstructable");
    if (
      object(native.message) &&
      native.message.role === "assistant" &&
      Array.isArray(native.message.diagnostics) &&
      native.message.diagnostics.some((value) => object(value) && value.type === "codex_failure")
    )
      return refuse("restored_assistant_diagnostics_may_be_redacted");
    const mapping = mapped(native);
    if (
      mapping.isErr() ||
      canonical(mapping.value) !== canonical(record) ||
      canonical(mapping.value.overflow.native) !== canonical(native)
    )
      return refuse("restored_native_projection_mismatch");
  }
  const first = restored[0]?.overflow.native;
  if (!object(first) || !truncatedPrefix(lines[prefixCount + 1] ?? "", first))
    return refuse("malformed_bytes_not_verified_replica_prefix");
  const firstLocal = local[0];
  if (!firstLocal) return refuse("missing_local_tail");
  const reparented = { ...firstLocal, parentId: snapshot.cursor };
  const candidate = [
    ...lines.slice(0, prefixCount + 1),
    ...restored.map((record) => JSON.stringify(record.overflow.native)),
    JSON.stringify(reparented),
    ...lines.slice(prefixCount + 3, -1),
  ]
    .join("\n")
    .concat("\n");
  // Strict re-read, never SDK SessionManager: validate every line and production projection.
  const finalRecords: HistoryRecord[] = [];
  for (const raw of candidate.split("\n").slice(1, -1)) {
    const parsed = parseJson(raw);
    if (parsed.isErr() || !object(parsed.value)) return refuse("candidate_strict_parse_failed");
    const mapping = mapped(parsed.value);
    if (mapping.isErr()) return err(mapping.error);
    finalRecords.push(mapping.value);
  }
  const restoredIds = new Set(restored.map((record) => record.id));
  const calls = new Set<string>();
  for (const record of finalRecords) {
    if (record.type !== "message") continue;
    for (const block of record.content) {
      if (block.type === "tool_call") calls.add(block.callId);
      if (block.type === "tool_result" && restoredIds.has(record.id) && !calls.has(block.callId))
        return refuse("restored_tool_result_has_no_preceding_call");
    }
  }
  const expected = [...snapshot.records];
  for (const native of [reparented, ...local.slice(1)]) {
    const mapping = mapped(native);
    if (mapping.isErr()) return err(mapping.error);
    expected.push(mapping.value);
  }
  if (
    !linear(finalRecords) ||
    canonical(finalRecords) !== canonical(expected) ||
    finalRecords.at(-1)?.id !== local.at(-1)?.id ||
    !finalRecords.some((record) => record.id === snapshot.cursor)
  )
    return refuse("candidate_ancestry_or_projection_failed");
  return ok({
    candidate,
    metadata: {
      orbId,
      sessionId: snapshot.session?.id,
      commonRecords: prefixCount,
      restoredIds: restored.map((record) => record.id),
      localTailIds: local.map((entry) => entry.id),
      removedMalformedLine: prefixCount + 2,
      reparented: { id: firstLocal.id, before: firstLocal.parentId, after: snapshot.cursor },
      expectedAppendCursor: local.at(-1)?.id,
      expectedSelectedHead: local.at(-1)?.id,
      unchangedSqlCursor: snapshot.cursor,
      unchangedSqlHead: snapshot.headId,
      proof: {
        version: sql.version,
        complete: sql.complete,
        rowCount: sql.rowCount,
        state: sql.state,
        hostRef: sql.hostRef,
        completeness: "operator_attested_not_independently_verified",
      },
    },
  });
}

type Input = { bytes: Buffer; text: string };
async function recoverSession(options: Options, session: Input, replica: Input) {
  if (!options.state || !options.backup) return refuse("missing_recovery_paths");
  const proof = await read(options.state);
  if (proof.isErr()) return err(proof.error);
  const plan = recoveryPlan(session.text, replica.text, proof.value.text);
  if (plan.isErr()) return err(plan.error);
  const paths = await io("path_resolution_failed", async () => ({
    session: await realpath(options.session),
    parent: await realpath(dirname(options.session)),
    backupParent: await realpath(dirname(resolve(options.backup ?? ""))),
    outputParent: options.output ? await realpath(dirname(resolve(options.output))) : null,
    stat: await lstat(options.session),
  }));
  if (paths.isErr()) return err(paths.error);
  const p = paths.value;
  const inside = (path: string) => {
    const rel = relative(p.parent, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (
    !p.stat.isFile() ||
    p.stat.isSymbolicLink() ||
    p.stat.nlink !== 1 ||
    inside(p.backupParent) ||
    (p.outputParent !== null && inside(p.outputParent))
  )
    return refuse("paths_not_external_or_session_not_single_regular_file");
  const backup = resolve(p.backupParent, resolve(options.backup).split("/").at(-1) ?? "");
  const target = options.output
    ? resolve(p.outputParent ?? "", resolve(options.output).split("/").at(-1) ?? "")
    : p.session;
  const report = {
    ...plan.value.metadata,
    operation: options.output ? "candidate" : "atomic_replace",
    observedAt: new Date().toISOString(),
    inputs: {
      session: p.session,
      replica: resolve(options.replica),
      replicaState: resolve(options.state),
    },
    backupDir: backup,
    target,
    originalFile: {
      uid: p.stat.uid,
      gid: p.stat.gid,
      mode: p.stat.mode & 0o7777,
      device: p.stat.dev,
      inode: p.stat.ino,
    },
    fingerprints: {
      session: fingerprint(session.bytes),
      replica: fingerprint(replica.bytes),
      replicaState: fingerprint(proof.value.bytes),
      candidate: fingerprint(plan.value.candidate),
    },
  };
  const writeExclusive = (
    path: string,
    bytes: Buffer | string,
    mode: number,
    preserveOwner = false,
  ) =>
    io(`exclusive_write_or_fsync_failed:${path}`, async () => {
      const file = await open(path, "wx", mode);
      try {
        await file.writeFile(bytes);
        if (preserveOwner) {
          await file.chown(p.stat.uid, p.stat.gid);
          await file.chmod(p.stat.mode & 0o7777);
        }
        await file.sync();
      } finally {
        await file.close();
      }
    });
  const syncDirectory = (path: string) =>
    io(`directory_fsync_failed:${path}`, async () => {
      const dir = await open(path, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    });
  const created = await io(`backup_directory_must_be_new:${backup}`, () =>
    mkdir(backup, { mode: 0o700 }),
  );
  if (created.isErr()) return err(created.error);
  for (const [name, bytes] of [
    ["session.original.jsonl", session.bytes],
    ["replica.original.json", replica.bytes],
    ["replica-state.original.json", proof.value.bytes],
    ["candidate.jsonl", plan.value.candidate],
    ["plan.json", JSON.stringify(report, null, 2)],
  ] as const) {
    const written = await writeExclusive(`${backup}/${name}`, bytes, 0o400);
    if (written.isErr()) return err(written.error);
  }
  for (const dir of [backup, p.backupParent]) {
    const synced = await syncDirectory(dir);
    if (synced.isErr()) return err(synced.error);
  }
  const temporary = options.output
    ? target
    : `${p.session}.recovery-${fingerprint(session.bytes).slice(0, 16)}.tmp`;
  const written = await writeExclusive(
    temporary,
    plan.value.candidate,
    options.output ? 0o400 : p.stat.mode & 0o7777,
    !options.output,
  );
  if (written.isErr()) return err(written.error);
  const reread = await read(temporary);
  if (reread.isErr() || !reread.value.bytes.equals(Buffer.from(plan.value.candidate)))
    return refuse("written_candidate_verification_failed");
  const unchanged = await io("input_recheck_failed", async () => ({
    bytes: await readFile(p.session),
    stat: await lstat(options.session),
    resolved: await realpath(options.session),
    parent: await realpath(dirname(options.session)),
  }));
  if (unchanged.isErr()) return err(unchanged.error);
  if (
    !unchanged.value.bytes.equals(session.bytes) ||
    unchanged.value.stat.ino !== p.stat.ino ||
    unchanged.value.stat.dev !== p.stat.dev ||
    unchanged.value.stat.isSymbolicLink() ||
    !unchanged.value.stat.isFile() ||
    unchanged.value.stat.nlink !== 1 ||
    unchanged.value.stat.uid !== p.stat.uid ||
    unchanged.value.stat.gid !== p.stat.gid ||
    unchanged.value.stat.mode !== p.stat.mode ||
    unchanged.value.resolved !== p.session ||
    unchanged.value.parent !== p.parent
  ) {
    const removed = await io("temporary_cleanup_failed", () => unlink(temporary));
    if (removed.isErr()) return err(removed.error);
    return refuse("session_changed_before_atomic_replace");
  }
  if (!options.output) {
    const replaced = await io("atomic_rename_failed", () => rename(temporary, p.session));
    if (replaced.isErr()) return err(replaced.error);
  }
  const synced = await syncDirectory(dirname(target));
  if (synced.isErr()) return err(synced.error);
  const final = await read(target);
  if (final.isErr() || !final.value.bytes.equals(Buffer.from(plan.value.candidate)))
    return refuse("final_file_verification_failed_after_write");
  if (!options.output) {
    const finalStat = await io("final_stat_failed_after_write", () => lstat(target));
    if (finalStat.isErr()) return err(finalStat.error);
    if (
      !finalStat.value.isFile() ||
      finalStat.value.uid !== p.stat.uid ||
      finalStat.value.gid !== p.stat.gid ||
      finalStat.value.mode !== p.stat.mode
    )
      return refuse("final_ownership_or_permissions_mismatch_after_write");
  }
  const outcome = {
    ...report,
    outcome: options.output
      ? "candidate_verified_session_unchanged"
      : "session_replaced_and_verified",
  };
  const recorded = await writeExclusive(
    `${backup}/outcome.json`,
    JSON.stringify(outcome, null, 2),
    0o400,
  );
  if (recorded.isErr()) return err(recorded.error);
  const durable = await syncDirectory(backup);
  return durable.isErr() ? err(durable.error) : ok(outcome);
}

async function main(): Promise<number> {
  if (process.argv.slice(2).join(" ") === "--help") {
    console.log(usage);
    return 0;
  }
  const options = args(process.argv.slice(2));
  if (options.isErr()) {
    console.error(options.error.message);
    return 2;
  }
  const session = await read(options.value.session);
  const replica = await read(options.value.replica);
  if (session.isErr() || replica.isErr()) {
    const failure = session.isErr() ? session.error : replica.isErr() ? replica.error : undefined;
    console.error(
      options.value.recover
        ? JSON.stringify({ outcome: "refused_or_incomplete", ...failure })
        : failure?.message,
    );
    return 2;
  }
  if (options.value.recover) {
    const recovered = await recoverSession(options.value, session.value, replica.value);
    if (recovered.isErr()) {
      console.error(JSON.stringify({ outcome: "refused_or_incomplete", ...recovered.error }));
      return 2;
    }
    console.log(JSON.stringify(recovered.value, null, 2));
    return 0;
  }
  const result = diagnose(session.value.text, replica.value.text);
  if (result.isErr()) {
    console.error(result.error.message);
    return 2;
  }
  const report = {
    ...result.value,
    inputs: {
      session: options.value.session,
      replica: options.value.replica,
      sessionSha256: createHash("sha256").update(session.value.bytes).digest("hex"),
      replicaSha256: createHash("sha256").update(replica.value.bytes).digest("hex"),
    },
    observedAt: new Date().toISOString(),
  };
  if (options.value.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Read-only diagnosis: ${report.counts.disk} disk records / ${report.counts.replica} replica records. No repair.`,
    );
    console.log(
      `Session identity/header match: ${report.headers.identityMatches}/${report.headers.nativeMatches}`,
    );
    for (const pointer of report.replicaPointers)
      console.log(
        `Replica ${pointer.key}: ${pointer.id ?? "none"}; present locally: ${pointer.presentLocally}`,
      );
    console.log(`Disk-only (not proof unreplicated): ${JSON.stringify(report.diskOnly)}`);
    console.log(
      `Replica-only (absent from parseable disk records): ${JSON.stringify(report.replicaOnly)}`,
    );
    console.log(`Content divergences: ${report.contentDivergenceIds.join(", ") || "none"}`);
    console.log(`Comparisons unavailable: ${report.comparisonUnavailableIds.join(", ") || "none"}`);
    console.log(
      `Intentionally projected: ${report.intentionallyProjectedIds.join(", ") || "none"}`,
    );
    console.log(`JSONL issues: ${JSON.stringify(report.jsonlIssues)}`);
    console.log(`Order: ${JSON.stringify(report.order)}`);
    console.log(`Graphs: ${JSON.stringify(report.graphs)}`);
    console.log(
      `Replica native unavailable/identity mismatch: ${JSON.stringify(report.replicaNativeUnavailableIds)}/${JSON.stringify(report.replicaIdentityMismatchIds)}`,
    );
    for (const warning of report.warnings) console.log(`Warning: ${warning}`);
    console.log(
      "Preserve --json stdout externally with the inputs; inspect reported lines/IDs. No automatic repair.",
    );
  }
  return 0;
}
process.exitCode = await main();
