import { randomUUID } from "node:crypto";
import {
  CAPABILITY_ABORT,
  CAPABILITY_INPUT_IMAGE,
  ClientFrameSchema,
  type RequestResultFrame,
  type ServerFrame,
} from "@pi-orb/protocol";
import { Result } from "neverthrow";
import { Check } from "typebox/value";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { computeSyncFrames } from "../../../orb-runtime/src/domain/sync.ts";
import type { AgentSessionFacade } from "../domain/agent-ports.ts";

interface LiveSocket {
  readonly bufferedAmount: number;
  send(text: string): void;
  close(code: number, reason: string): void;
  on(event: "message", handler: (data: Buffer, binary: boolean) => void): unknown;
  on(event: "close" | "error", handler: () => void): unknown;
  off(event: "message", handler: (data: Buffer, binary: boolean) => void): unknown;
}

/** Existing JSON protocol, with no guest socket or synthetic agent server. */
export function attachCentralLive(
  socket: LiveSocket,
  session: AgentSessionFacade,
  pending: readonly string[] = [],
  onFailure: (requestId: string, retryable: boolean) => void = () => undefined,
): () => void {
  const writer = new OutboundWriter(socket, {
    maxCriticalBufferedBytes: 1024 * 1024,
    highWaterMark: 256 * 1024,
  });
  let helloSeen = false;
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const interval = setInterval(() => writer.onDrain(), 25);
  interval.unref();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    unsubscribe();
    socket.off("message", receive);
  };
  const reply = (requestId: string, result: RequestResultFrame["result"]) => {
    if (!closed)
      writer.enqueue({
        v: 1,
        type: "request.result",
        at: new Date().toISOString(),
        requestId,
        result,
      });
  };
  const receive = async (data: Buffer, binary: boolean) => {
    if (closed) return;
    if (binary) {
      socket.close(1003, "binary frames are not accepted");
      cleanup();
      return;
    }
    if (data.byteLength > 8 * 1024 * 1024) {
      socket.close(1009, "frame too large");
      cleanup();
      return;
    }
    const parsed = Result.fromThrowable(
      () => JSON.parse(data.toString()) as unknown,
      () => ({ message: "frame is not JSON" }),
    )();
    if (parsed.isErr() || !Check(ClientFrameSchema, parsed.value)) {
      const value = parsed.isOk() ? parsed.value : null;
      if (
        typeof value === "object" &&
        value !== null &&
        "requestId" in value &&
        typeof value.requestId === "string"
      )
        reply(value.requestId, {
          type: "rejected",
          error: { code: "invalid_request", message: "invalid frame", retryable: false },
        });
      else
        writer.enqueue({
          v: 1,
          type: "server.error",
          at: new Date().toISOString(),
          error: { code: "invalid_frame", message: "invalid frame", retryable: false },
        });
      return;
    }
    const frame = parsed.value;
    if (frame.type === "client.presence") return;
    if (frame.type === "client.hello") {
      if (helloSeen) return;
      helloSeen = true;
      let syncing = true;
      const buffered: ServerFrame[] = [];
      let bufferedBytes = 0;
      unsubscribe = session.subscribe(
        (event) => {
          if (closed) return;
          if (!syncing) {
            writer.enqueue(event);
            return;
          }
          bufferedBytes += Buffer.byteLength(JSON.stringify(event));
          if (bufferedBytes > 1024 * 1024) {
            cleanup();
            socket.close(1013, "conversation synchronization overflow");
            return;
          }
          buffered.push(event);
        },
        () => {
          cleanup();
          socket.close(1012, "agent owner changed");
        },
      );
      if (closed) {
        unsubscribe();
        return;
      }
      const snapshot = session.readSnapshot ? await session.readSnapshot() : session.snapshot();
      if (closed) return;
      if (snapshot.isErr()) {
        socket.close(1013, "agent is not ready");
        cleanup();
        return;
      }
      const at = new Date().toISOString();
      const welcome: ServerFrame = {
        v: 1,
        type: "server.welcome",
        at,
        connectionId: randomUUID(),
        runtimeInstanceId: session.runtimeInstanceId,
        orbId: snapshot.value.orbId,
        sessionId: snapshot.value.session.id,
        capabilities: [CAPABILITY_ABORT, CAPABILITY_INPUT_IMAGE],
        limits: { maxIncomingFrameBytes: 8 * 1024 * 1024, maxPromptBytes: 6 * 1024 * 1024 },
      };
      writer.enqueueSyncBatch([
        welcome,
        ...computeSyncFrames(snapshot.value, session.liveView(), frame.afterRecordId, at),
      ]);
      syncing = false;
      for (const event of buffered) writer.enqueue(event);
      buffered.length = 0;
      if (closed) unsubscribe();
      return;
    }
    if (!helloSeen) {
      reply(frame.requestId, {
        type: "rejected",
        error: {
          code: "invalid_request",
          message: "requests are rejected before client.hello",
          retryable: false,
        },
      });
      return;
    }
    if (JSON.stringify(frame.action).length > 6 * 1024 * 1024) {
      reply(frame.requestId, {
        type: "rejected",
        error: { code: "invalid_request", message: "input too large", retryable: false },
      });
      return;
    }
    void session.request(frame.requestId, frame.action).then((result) => {
      if (result.isErr()) onFailure(frame.requestId, result.error.retryable);
      reply(
        frame.requestId,
        result.isOk()
          ? result.value
          : {
              type: "rejected",
              error: {
                code: "internal",
                message: "Agent request failed.",
                retryable: result.error.retryable,
              },
            },
      );
    });
  };
  socket.on("message", receive);
  socket.on("close", cleanup);
  socket.on("error", cleanup);
  for (const frame of pending) receive(Buffer.from(frame), false);
  return cleanup;
}
