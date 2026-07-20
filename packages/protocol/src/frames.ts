import { type Static, Type } from "typebox";
import { HistoryRecordSchema } from "./history.ts";
import { JsonValueSchema } from "./json.ts";

const closed = { additionalProperties: false } as const;

/** WebSocket subprotocol negotiating the major wire version. */
export const RUNTIME_SUBPROTOCOL = "pi-orb.runtime.v1";

export const CAPABILITY_ABORT = "abort";
export const CAPABILITY_INPUT_IMAGE = "input.image";

export const ClientHelloSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("client.hello"),
    /** Stable UUID for this browser tab. */
    clientInstanceId: Type.String(),
    /** Last complete record applied by the UI. */
    afterRecordId: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type ClientHello = Static<typeof ClientHelloSchema>;

export const ClientActionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("message"),
      expectedHeadId: Type.Union([Type.String(), Type.Null()]),
      content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() }, closed)),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("abort"),
      operationId: Type.String(),
    },
    closed,
  ),
]);
export type ClientAction = Static<typeof ClientActionSchema>;

export const ClientRequestSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("client.request"),
    requestId: Type.String(),
    action: ClientActionSchema,
  },
  closed,
);
export type ClientRequest = Static<typeof ClientRequestSchema>;

export const ClientFrameSchema = Type.Union([ClientHelloSchema, ClientRequestSchema]);
export type ClientFrame = Static<typeof ClientFrameSchema>;

export const ServerWelcomeSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("server.welcome"),
    at: Type.String(),
    connectionId: Type.String(),
    runtimeInstanceId: Type.String(),
    orbId: Type.String(),
    sessionId: Type.String(),
    capabilities: Type.Array(Type.String()),
    limits: Type.Object(
      {
        maxIncomingFrameBytes: Type.Number(),
        maxPromptBytes: Type.Number(),
      },
      closed,
    ),
  },
  closed,
);
export type ServerWelcome = Static<typeof ServerWelcomeSchema>;

export const SyncStartedFrameSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("sync.started"),
    at: Type.String(),
    mode: Type.Union([Type.Literal("full"), Type.Literal("after")]),
    afterRecordId: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type SyncStartedFrame = Static<typeof SyncStartedFrameSchema>;

export const HistoryRecordFrameSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("history.record"),
    at: Type.String(),
    record: HistoryRecordSchema,
    headId: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type HistoryRecordFrame = Static<typeof HistoryRecordFrameSchema>;

export const SyncCompletedFrameSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("sync.completed"),
    at: Type.String(),
    headId: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type SyncCompletedFrame = Static<typeof SyncCompletedFrameSchema>;

export const RuntimeStatusEventSchema = Type.Object(
  {
    type: Type.Literal("status"),
    activity: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
    operationId: Type.Optional(Type.String()),
  },
  closed,
);
export type RuntimeStatusEvent = Static<typeof RuntimeStatusEventSchema>;

export const OperationStartedEventSchema = Type.Object(
  {
    type: Type.Literal("operation_started"),
    operationId: Type.String(),
  },
  closed,
);
export type OperationStartedEvent = Static<typeof OperationStartedEventSchema>;

export const OutputPatchEventSchema = Type.Object(
  {
    type: Type.Literal("output_patch"),
    operationId: Type.String(),
    blockId: Type.String(),
    blockType: Type.Union([Type.Literal("text"), Type.Literal("reasoning")]),
    revision: Type.Number(),
    patch: Type.Union([
      Type.Object({ type: Type.Literal("append"), text: Type.String() }, closed),
      Type.Object({ type: Type.Literal("replace"), text: Type.String() }, closed),
    ]),
  },
  closed,
);
export type OutputPatchEvent = Static<typeof OutputPatchEventSchema>;

export const ToolStateEventSchema = Type.Object(
  {
    type: Type.Literal("tool_state"),
    operationId: Type.String(),
    callId: Type.String(),
    name: Type.String(),
    revision: Type.Number(),
    state: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
    message: Type.Optional(Type.String()),
    data: Type.Optional(JsonValueSchema),
  },
  closed,
);
export type ToolStateEvent = Static<typeof ToolStateEventSchema>;

export const OperationFinishedEventSchema = Type.Object(
  {
    type: Type.Literal("operation_finished"),
    operationId: Type.String(),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("aborted"),
      Type.Literal("failed"),
    ]),
    message: Type.Optional(Type.String()),
  },
  closed,
);
export type OperationFinishedEvent = Static<typeof OperationFinishedEventSchema>;

export const RuntimeEventSchema = Type.Union([
  RuntimeStatusEventSchema,
  OperationStartedEventSchema,
  OutputPatchEventSchema,
  ToolStateEventSchema,
  OperationFinishedEventSchema,
]);
export type RuntimeEvent = Static<typeof RuntimeEventSchema>;

export const RuntimeEventFrameSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("runtime.event"),
    at: Type.String(),
    event: RuntimeEventSchema,
  },
  closed,
);
export type RuntimeEventFrame = Static<typeof RuntimeEventFrameSchema>;

export const RequestResultFrameSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("request.result"),
    at: Type.String(),
    requestId: Type.String(),
    result: Type.Union([
      Type.Object(
        {
          type: Type.Literal("accepted"),
          operationId: Type.String(),
          duplicate: Type.Boolean(),
        },
        closed,
      ),
      Type.Object(
        {
          type: Type.Literal("rejected"),
          error: Type.Object(
            {
              code: Type.Union([
                Type.Literal("invalid_request"),
                Type.Literal("unsupported"),
                Type.Literal("busy"),
                Type.Literal("stale_head"),
                Type.Literal("stale_operation"),
                Type.Literal("request_id_conflict"),
                Type.Literal("internal"),
              ]),
              message: Type.String(),
              retryable: Type.Boolean(),
            },
            closed,
          ),
        },
        closed,
      ),
    ]),
  },
  closed,
);
export type RequestResultFrame = Static<typeof RequestResultFrameSchema>;

export const ServerErrorFrameSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("server.error"),
    at: Type.String(),
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        retryable: Type.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
export type ServerErrorFrame = Static<typeof ServerErrorFrameSchema>;

export const ServerFrameSchema = Type.Union([
  ServerWelcomeSchema,
  SyncStartedFrameSchema,
  HistoryRecordFrameSchema,
  RuntimeEventFrameSchema,
  SyncCompletedFrameSchema,
  RequestResultFrameSchema,
  ServerErrorFrameSchema,
]);
export type ServerFrame = Static<typeof ServerFrameSchema>;
