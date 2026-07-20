import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { Check } from "typebox/value";
import {
  CAPABILITY_ABORT,
  CAPABILITY_INPUT_IMAGE,
  ClientFrameSchema,
  HISTORY_PULL_DEFAULT_LIMIT,
  RUNTIME_SUBPROTOCOL,
  type ClientRequest,
  type RequestResultFrame,
  type RuntimeHttpError,
  type ServerFrame,
} from "@pi-orb/protocol";
import { computePullHistory } from "../domain/history.ts";
import { OutboundWriter, type FrameSink } from "../domain/outbound.ts";
import { decideRequest, RequestRegistry, type RequestResult } from "../domain/requests.ts";
import { computeSyncFrames } from "../domain/sync.ts";
import type { PiOrbAgent } from "../pi/agent.ts";

const MAX_INCOMING_FRAME_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const OUTBOUND_BUDGET_BYTES = 8 * 1024 * 1024;
const HIGH_WATER_MARK_BYTES = 512 * 1024;

function runtimeError(
  code: RuntimeHttpError["error"]["code"],
  message: string,
  retryable: boolean,
): RuntimeHttpError {
  return { v: 1, error: { code, message, retryable } };
}

/**
 * The orb runtime's HTTP surface (DESIGN.md §5.1, §6, §8.1): health,
 * idempotent history pulls, and the live WebSocket with synchronous hello
 * synchronization. The health server starts before slow initialization.
 */
export function buildRuntimeServer(agent: PiOrbAgent): FastifyInstance {
  const app = Fastify({ logger: false });
  const registry = new RequestRegistry();

  app.get("/v1/health", async (_request, reply) => reply.status(200).send(agent.getHealth()));

  app.get<{ Querystring: { after?: string; limit?: string } }>(
    "/v1/history",
    async (request, reply) => {
      const health = agent.getHealth();
      if (health.status !== "ready") {
        return reply
          .status(503)
          .send(runtimeError("history_unavailable", "runtime is not ready", true));
      }
      const limitRaw = request.query.limit;
      const limit = limitRaw === undefined ? HISTORY_PULL_DEFAULT_LIMIT : Number(limitRaw);
      if (limitRaw !== undefined && !Number.isInteger(limit)) {
        return reply
          .status(400)
          .send(runtimeError("invalid_request", "limit must be an integer", false));
      }
      const snapshot = agent.snapshot();
      if (snapshot.isErr()) {
        return reply
          .status(503)
          .send(runtimeError("history_unavailable", snapshot.error.message, true));
      }
      const response = computePullHistory(snapshot.value, {
        after: request.query.after ?? null,
        limit,
      });
      if (response.isErr()) {
        const status =
          response.error.code === "invalid_request"
            ? 400
            : response.error.code === "cursor_not_found"
              ? 409
              : 503;
        return reply
          .status(status)
          .send(
            runtimeError(response.error.code, response.error.message, response.error.retryable),
          );
      }
      return reply.status(200).send(response.value);
    },
  );

  void app.register(websocketPlugin, {
    options: {
      maxPayload: MAX_INCOMING_FRAME_BYTES,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(RUNTIME_SUBPROTOCOL) ? RUNTIME_SUBPROTOCOL : false,
    },
  });

  void app.register(async (scope) => {
    scope.get("/v1/live", { websocket: true }, (socket) => {
      const sink: FrameSink = {
        send: (json) => socket.send(json),
        close: (code, reason) => socket.close(code, reason),
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
      };
      const writer = new OutboundWriter(sink, {
        maxCriticalBufferedBytes: OUTBOUND_BUDGET_BYTES,
        highWaterMark: HIGH_WATER_MARK_BYTES,
      });
      const drainTimer = setInterval(() => writer.onDrain(), 50);
      let unsubscribe: (() => void) | null = null;
      let helloSeen = false;

      const cleanup = (): void => {
        clearInterval(drainTimer);
        unsubscribe?.();
        unsubscribe = null;
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);

      const sendResult = (requestId: string, result: RequestResult): void => {
        const frame: RequestResultFrame = {
          v: 1,
          type: "request.result",
          at: new Date().toISOString(),
          requestId,
          result,
        };
        writer.enqueue(frame);
      };

      const handleRequest = (frame: ClientRequest): void => {
        const known = registry.lookup(frame.requestId, frame.action);
        if (known.type === "replay") {
          sendResult(frame.requestId, known.result);
          return;
        }
        if (known.type === "conflict") {
          sendResult(frame.requestId, {
            type: "rejected",
            error: {
              code: "request_id_conflict",
              message: "request id was already used with a different action",
              retryable: false,
            },
          });
          return;
        }
        if (
          frame.action.type === "message" &&
          JSON.stringify(frame.action.content).length > MAX_PROMPT_BYTES
        ) {
          const result: RequestResult = {
            type: "rejected",
            error: { code: "invalid_request", message: "prompt too large", retryable: false },
          };
          registry.record(frame.requestId, frame.action, result);
          sendResult(frame.requestId, result);
          return;
        }
        // All mutating requests pass through this single synchronous gate on
        // the event loop (DESIGN.md §6.5).
        const decision = decideRequest(agent.gateView(), frame.action);
        if (decision.type === "reject") {
          const result: RequestResult = {
            type: "rejected",
            error: {
              code: decision.code,
              message: decision.message,
              retryable: decision.retryable,
            },
          };
          registry.record(frame.requestId, frame.action, result);
          sendResult(frame.requestId, result);
          return;
        }
        if (decision.type === "abort_operation") {
          const result: RequestResult = {
            type: "accepted",
            operationId: decision.operationId,
            duplicate: false,
          };
          registry.record(frame.requestId, frame.action, result);
          sendResult(frame.requestId, result);
          void agent.abortOperation();
          return;
        }
        // start_message: acceptance is not completion (§6.3). The operation
        // id becomes visible through operation_started once Pi starts.
        const text =
          frame.action.type === "message"
            ? frame.action.content.map((block) => block.text).join("\n")
            : "";
        const operationId = randomUUID();
        const result: RequestResult = { type: "accepted", operationId, duplicate: false };
        registry.record(frame.requestId, frame.action, result);
        sendResult(frame.requestId, result);
        void agent.submitMessage(text, operationId);
      };

      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          cleanup();
          socket.close(1003, "binary frames are not accepted");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          const frame: ServerFrame = {
            v: 1,
            type: "server.error",
            at: new Date().toISOString(),
            error: { code: "invalid_frame", message: "frame is not JSON", retryable: false },
          };
          writer.enqueue(frame);
          return;
        }
        if (!Check(ClientFrameSchema, parsed)) {
          const maybeRequest = parsed as { requestId?: unknown };
          if (typeof maybeRequest.requestId === "string") {
            sendResult(maybeRequest.requestId, {
              type: "rejected",
              error: { code: "invalid_request", message: "invalid frame", retryable: false },
            });
          } else {
            writer.enqueue({
              v: 1,
              type: "server.error",
              at: new Date().toISOString(),
              error: { code: "invalid_frame", message: "unrecognized frame", retryable: false },
            });
          }
          return;
        }
        if (parsed.type === "client.hello") {
          if (helloSeen) return;
          helloSeen = true;
          // Synchronous synchronization preparation (§6.2): no await between
          // reading the snapshot and enqueueing the batch.
          const snapshot = agent.snapshot();
          const sessionId = agent.sessionId();
          if (snapshot.isErr() || sessionId === null) {
            socket.close(1013, "runtime is not ready");
            cleanup();
            return;
          }
          const at = new Date().toISOString();
          const welcome: ServerFrame = {
            v: 1,
            type: "server.welcome",
            at,
            connectionId: randomUUID(),
            runtimeInstanceId: agent.runtimeInstanceId,
            orbId: snapshot.value.orbId,
            sessionId,
            capabilities: [CAPABILITY_ABORT, CAPABILITY_INPUT_IMAGE],
            limits: {
              maxIncomingFrameBytes: MAX_INCOMING_FRAME_BYTES,
              maxPromptBytes: MAX_PROMPT_BYTES,
            },
          };
          const sync = computeSyncFrames(
            snapshot.value,
            agent.liveView(),
            parsed.afterRecordId,
            at,
          );
          writer.enqueueSyncBatch([welcome, ...sync]);
          // Subsequent live frames append after sync.completed.
          unsubscribe = agent.subscribe((frame) => writer.enqueue(frame));
          return;
        }
        if (!helloSeen) {
          sendResult(parsed.requestId, {
            type: "rejected",
            error: {
              code: "invalid_request",
              message: "requests are rejected before client.hello",
              retryable: false,
            },
          });
          return;
        }
        handleRequest(parsed);
      });
    });
  });

  return app;
}
