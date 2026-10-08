import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, Result, ResultAsync } from "neverthrow";

export type AuditError = {
  type: "audit_missing" | "audit_unavailable" | "audit_invalid" | "audit_write_failed";
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type AuditEvent =
  | "request_create"
  | "before_connect"
  | "connected"
  | "connect_error"
  | "send_headers"
  | "headers"
  | "error"
  | "body_sent"
  | "trailers";
export type NativeAuditSnapshot = {
  version: 1;
  orb: string;
  pid: number;
  startup: {
    at: number;
    node: string;
    undici: string | null;
    configuredThreadpoolSize: number | null;
  };
  events: {
    sequence: number;
    event: AuditEvent;
    at: number;
    elapsedMs: number;
    request: number | null;
    socket: number | null;
    status: number | null;
    error: string | null;
  }[];
  activeRequests: {
    request: number;
    createdAt: number;
    lastAt: number;
    lastEvent: AuditEvent;
    socket: number | null;
  }[];
  droppedCount: number;
  activeDroppedCount: number;
  callbackErrorCount: number;
  writeErrorCount: number;
};
const cap = 64 * 1024;
const events = [
  "request_create",
  "before_connect",
  "connected",
  "connect_error",
  "send_headers",
  "headers",
  "error",
  "body_sent",
  "trailers",
];
const errors = [
  "AbortError",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "other",
];
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullableCount = (v: unknown) => v === null || count(v);
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).sort().join() === expected.sort().join();
function valid(value: unknown, orb: string, pid: number): value is NativeAuditSnapshot {
  if (
    !record(value) ||
    !keys(value, [
      "version",
      "orb",
      "pid",
      "startup",
      "events",
      "droppedCount",
      "activeRequests",
      "activeDroppedCount",
      "callbackErrorCount",
      "writeErrorCount",
    ]) ||
    value.version !== 1 ||
    value.orb !== orb ||
    value.pid !== pid
  )
    return false;
  const startup = value.startup;
  if (
    !record(startup) ||
    !keys(startup, ["at", "node", "undici", "configuredThreadpoolSize"]) ||
    !count(startup.at) ||
    typeof startup.node !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(startup.node) ||
    !(
      startup.undici === null ||
      (typeof startup.undici === "string" && /^\d+\.\d+\.\d+$/.test(startup.undici))
    ) ||
    !(
      startup.configuredThreadpoolSize === null ||
      (count(startup.configuredThreadpoolSize) && startup.configuredThreadpoolSize > 0)
    )
  )
    return false;
  for (const field of [
    "droppedCount",
    "activeDroppedCount",
    "callbackErrorCount",
    "writeErrorCount",
  ])
    if (!count(value[field])) return false;
  if (
    !Array.isArray(value.events) ||
    value.events.length > 64 ||
    !Array.isArray(value.activeRequests) ||
    value.activeRequests.length > 64
  )
    return false;
  return (
    value.events.every(
      (row) =>
        record(row) &&
        keys(row, [
          "sequence",
          "event",
          "at",
          "elapsedMs",
          "request",
          "socket",
          "status",
          "error",
        ]) &&
        count(row.sequence) &&
        typeof row.event === "string" &&
        events.includes(row.event) &&
        count(row.at) &&
        typeof row.elapsedMs === "number" &&
        Number.isFinite(row.elapsedMs) &&
        row.elapsedMs >= 0 &&
        nullableCount(row.request) &&
        nullableCount(row.socket) &&
        (row.status === null || (count(row.status) && row.status >= 100 && row.status <= 599)) &&
        (row.error === null || (typeof row.error === "string" && errors.includes(row.error))),
    ) &&
    value.activeRequests.every(
      (row) =>
        record(row) &&
        keys(row, ["request", "createdAt", "lastAt", "lastEvent", "socket"]) &&
        count(row.request) &&
        count(row.createdAt) &&
        count(row.lastAt) &&
        typeof row.lastEvent === "string" &&
        events.includes(row.lastEvent) &&
        nullableCount(row.socket),
    )
  );
}

export type NativeAudit = {
  directory: string;
  extraEnv: Record<string, string>;
  bracket(
    phase: "setup" | "continuation" | "abort" | "recovery" | "archive" | "profiles",
    caseIndex?: number,
  ): void;
  brackets(): { phase: string; caseIndex: number | null; at: number }[];
  read(orb: string): Result<NativeAuditSnapshot[], AuditError>;
  save(orb: string, artifact: string, phase: string): ResultAsync<void, AuditError>;
};
export function startNativeInferenceAudit(
  root: string,
  inferenceBaseUrl: string,
): Result<NativeAudit, AuditError> {
  return Result.fromThrowable(
    () => {
      const upstream = new URL(`${inferenceBaseUrl}/codex/responses`);
      const directory = join(root, "native-audit");
      mkdirSync(directory, { mode: 0o700 });
      const importUrl = pathToFileURL(
        resolve(import.meta.dirname, "native-inference-audit.mjs"),
      ).href;
      return { directory, origin: upstream.origin, path: upstream.pathname, importUrl };
    },
    (): AuditError => ({ type: "audit_unavailable" }),
  )().map(({ directory, origin, path, importUrl }) => {
    const brackets: { phase: string; caseIndex: number | null; at: number }[] = [];
    const read = (orb: string): Result<NativeAuditSnapshot[], AuditError> => {
      if (!uuid.test(orb)) return err({ type: "audit_invalid" });
      const loaded = Result.fromThrowable(
        () => {
          const names = readdirSync(directory).filter(
            (name) => name.startsWith(`${orb}-`) && name.endsWith(".json"),
          );
          if (names.length > 16) return null;
          return names.map((name) => {
            const pidText = name.slice(orb.length + 1, -5);
            if (!/^[1-9][0-9]*$/.test(pidText)) return null;
            const file = join(directory, name);
            if (lstatSync(file).isSymbolicLink()) return null;
            const fd = openSync(file, "r");
            try {
              const stat = fstatSync(fd);
              if (!stat.isFile() || stat.size > cap || (stat.mode & 0o777) !== 0o600) return null;
              const buffer = Buffer.alloc(cap + 1);
              let length = 0;
              while (length < buffer.length) {
                const n = readSync(fd, buffer, length, buffer.length - length, null);
                if (n === 0) break;
                length += n;
              }
              if (length > cap) return null;
              const value: unknown = JSON.parse(buffer.subarray(0, length).toString());
              return valid(value, orb, Number(pidText)) ? value : null;
            } finally {
              closeSync(fd);
            }
          });
        },
        (): AuditError => ({ type: "audit_unavailable" }),
      )();
      if (loaded.isErr()) return err(loaded.error);
      if (!loaded.value || loaded.value.some((value) => value === null))
        return err({ type: "audit_invalid" });
      if (loaded.value.length === 0) return err({ type: "audit_missing" });
      return ok(loaded.value as NativeAuditSnapshot[]);
    };
    return {
      directory,
      bracket: (phase, caseIndex) => {
        brackets.push({ phase, caseIndex: caseIndex ?? null, at: Date.now() });
        if (brackets.length > 64) brackets.shift();
      },
      brackets: () => brackets.map((row) => ({ ...row })),
      extraEnv: {
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(importUrl)}`.trim(),
        PI_ORB_TEST_AUDIT_DIR: directory,
        PI_ORB_TEST_AUDIT_ENTRY: resolve(import.meta.dirname, "../../apps/orb-runtime/src/main.ts"),
        PI_ORB_TEST_AUDIT_ORIGIN: origin,
        PI_ORB_TEST_AUDIT_PATH: path,
      },
      read,
      save: (orb, artifact, phase) => {
        const evidence = read(orb);
        const bundle = {
          orb,
          phase,
          brackets: brackets.map((row) => ({ ...row })),
          capturedAt: Date.now(),
          audit: evidence.isOk()
            ? { state: "available", processes: evidence.value }
            : { state: evidence.error.type },
        };
        return ResultAsync.fromThrowable(
          async () => {
            await mkdir(dirname(artifact), { recursive: true });
            await writeFile(`${artifact}.tmp`, JSON.stringify(bundle), { mode: 0o600 });
            await rename(`${artifact}.tmp`, artifact);
          },
          (): AuditError => ({ type: "audit_write_failed" }),
        )();
      },
    };
  });
}
