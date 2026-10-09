import { type Static, Type } from "typebox";
import { type RuntimeHooks, RuntimeHooksSchema } from "./runtime-http.ts";

export const EXECUTION_RPC_PATH = "/execution/rpc";
export const EXECUTION_EXEC_PATH = "/execution/exec";
export const EXECUTION_CANCEL_PATH = "/execution/cancel";
export const EXECUTION_READY_PATH = "/execution/ready";
export const ExecutionOperationSchema = Type.Union([
  ...[
    "absolutePath",
    "joinPath",
    "readTextFile",
    "readTextLines",
    "readBinaryFile",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "fileInfo",
    "listDir",
    "canonicalPath",
    "exists",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
    "openTextLineReader",
    "readerRead",
    "readerClose",
  ].map((value) => Type.Literal(value)),
]);
export type ExecutionOperation = Static<typeof ExecutionOperationSchema>;
export const ExecutionRpcSchema = Type.Object({
  operation: ExecutionOperationSchema,
  args: Type.Array(Type.Unknown(), { maxItems: 3 }),
  cwd: Type.String(),
});
export const ExecutionExecSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  command: Type.String(),
  cwd: Type.String(),
  options: Type.Optional(
    Type.Object({
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      inheritEnv: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Number()),
      spill: Type.Optional(Type.Object({ afterBytes: Type.Number(), afterLines: Type.Number() })),
    }),
  ),
});
export interface ExecutionResource {
  readonly path: string;
  readonly content: string;
}
/** Data only: repository JavaScript is never imported by the control plane. */
export interface ExecutionReady {
  readonly cwd: string;
  readonly incarnation: string;
  readonly pid: number;
  readonly checkoutCommit: string;
  readonly hooks?: RuntimeHooks;
  readonly instructions: readonly ExecutionResource[];
  readonly skills: readonly ExecutionResource[];
  readonly resources: readonly ExecutionResource[];
}
export const ExecutionReadySchema = Type.Object({
  cwd: Type.String(),
  incarnation: Type.String(),
  pid: Type.Integer(),
  checkoutCommit: Type.String(),
  hooks: Type.Optional(RuntimeHooksSchema),
  instructions: Type.Array(Type.Object({ path: Type.String(), content: Type.String() })),
  skills: Type.Array(Type.Object({ path: Type.String(), content: Type.String() })),
  resources: Type.Array(Type.Object({ path: Type.String(), content: Type.String() })),
});
export const ExecutionWireResultSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), value: Type.Optional(Type.Unknown()) }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      path: Type.Optional(Type.String()),
      spillPath: Type.Optional(Type.String()),
    }),
  }),
]);
export const ExecutionStreamFrameSchema = Type.Union([
  Type.Object({ type: Type.Literal("output"), text: Type.String() }),
  Type.Object({ type: Type.Literal("result"), result: ExecutionWireResultSchema }),
]);
export interface ExecutionWireError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly spillPath?: string;
}
export type ExecutionWireResult =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: ExecutionWireError };
export type ExecutionStreamFrame =
  | { readonly type: "output"; readonly text: string }
  | { readonly type: "result"; readonly result: ExecutionWireResult };
