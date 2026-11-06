import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ClientAction, ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildRuntimeServer } from "../http/server.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";

const task = new NoSimulationTask("claude-compact-http", false);
async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);
  const frames: ServerFrame[] = [];
  const waiters = new Set<() => void>();
  socket.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as ServerFrame);
    for (const waiter of waiters) waiter();
  });
  await once(socket, "open");
  function wait(predicate: (frame: ServerFrame) => boolean, offset = 0): Promise<ServerFrame> {
    const found = frames.slice(offset).find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve) => {
      const check = () => {
        const found = frames.slice(offset).find(predicate);
        if (found !== undefined) {
          waiters.delete(check);
          resolve(found);
        }
      };
      waiters.add(check);
    });
  }
  socket.send(
    JSON.stringify({ v: 1, type: "client.hello", clientInstanceId: "test", afterRecordId: null }),
  );
  await wait((frame) => frame.type === "sync.completed");
  return {
    socket,
    frames,
    wait,
    request: async (requestId: string, action: ClientAction) => {
      const offset = frames.length;
      socket.send(JSON.stringify({ v: 1, type: "client.request", requestId, action }));
      return wait(
        (frame) => frame.type === "request.result" && frame.requestId === requestId,
        offset,
      );
    },
  };
}

it.each(["completed", "failed", "aborted"] as const)(
  "Claude runtime handshake preserves compaction ownership, reconnect and canonical detail (%s)",
  async (outcome) => {
    const cancel = outcome === "aborted";
    const f = new ComposedClaudeFixture();
    const sockets: WebSocket[] = [];
    const app = buildRuntimeServer(f.agent, {
      closeAll: () => undefined,
    } as unknown as TerminalManager);
    try {
      f.append({ type: "assistant", uuid: "before", message: { content: "before" } });
      await f.attach();
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const client = await connect(port);
      sockets.push(client.socket);
      const next = f.nextQuery();
      const accepted = await client.request("compact", {
        type: "compact",
        customInstructions: "private instruction",
      });
      expect(accepted).toMatchObject({ result: { type: "accepted", duplicate: false } });
      if (accepted.type !== "request.result" || accepted.result.type !== "accepted")
        throw new Error("missing acceptance");
      const operationId = accepted.result.operationId;
      const query = await next;
      const command = await query.input.next();
      expect(command.value?.message.content).toBe("/compact private instruction");
      f.receipt(command.value!);
      expect(await client.request("busy", { type: "compact" })).toMatchObject({
        result: { type: "rejected", error: { code: "busy" } },
      });
      expect(
        await client.request("compact", {
          type: "compact",
          customInstructions: "private instruction",
        }),
      ).toMatchObject({ result: { type: "accepted", operationId, duplicate: true } });
      expect(
        (
          await f.agent.deliverInboxMessage(
            "queued",
            ["queued"],
            [{ type: "text", text: "waiting" }],
          )
        ).isErr(),
      ).toBe(true);
      const reconnect = await connect(port);
      sockets.push(reconnect.socket);
      expect(reconnect.frames).toContainEqual(
        expect.objectContaining({
          type: "runtime.event",
          event: expect.objectContaining({
            type: "status",
            activity: "busy",
            work: "compaction",
            compactionAfterId: "before",
          }),
        }),
      );
      if (cancel) {
        expect(await client.request("abort", { type: "abort", operationId })).toMatchObject({
          result: { type: "accepted", operationId },
        });
      } else if (outcome === "completed") {
        f.append({
          type: "system",
          subtype: "compact_boundary",
          uuid: "boundary",
          content: "Conversation compacted",
        });
        f.append({
          type: "user",
          uuid: "summary",
          parentUuid: "boundary",
          isCompactSummary: true,
          message: { content: "native summary" },
        });
        f.append({
          type: "user",
          uuid: "caveat",
          parentUuid: "summary",
          isMeta: true,
          message: {
            role: "user",
            content: "<local-command-caveat>Native command</local-command-caveat>",
          },
        });
        f.append({
          type: "user",
          uuid: "stdout",
          parentUuid: command.value?.uuid,
          message: {
            role: "user",
            content: "<local-command-stdout>Compacted </local-command-stdout>",
          },
        });
      }
      await query.emit(
        task,
        outcome === "failed"
          ? ({ ...rootResult, is_error: true } as typeof rootResult)
          : rootResult,
      );
      query.exit();
      expect(f.agent.gateView().activity).toBe("busy");
      query.endOutput();
      await client.wait(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
      );
      expect((await app.inject({ url: "/v1/health" })).json()).toMatchObject({
        status: "ready",
        activity: "idle",
      });
      const finished = await connect(port);
      sockets.push(finished.socket);
      expect(JSON.stringify(finished.frames)).not.toContain("private instruction");
      if (outcome !== "completed") {
        const message = cancel ? "Context compaction cancelled." : "Context compaction failed.";
        expect(
          finished.frames.filter(
            (frame) =>
              frame.type === "history.record" &&
              frame.record.type === "event" &&
              frame.record.eventType === "agent.compaction",
          ),
        ).toHaveLength(1);
        expect(finished.frames).toContainEqual(
          expect.objectContaining({
            type: "history.record",
            record: expect.objectContaining({
              eventType: "agent.compaction",
              compactionOutcome: outcome,
              content: [{ type: "text", text: message }],
            }),
          }),
        );
      } else {
        expect(JSON.stringify(finished.frames)).not.toContain("local-command-");
        expect(
          finished.frames.filter(
            (frame) => frame.type === "history.record" && frame.record.type === "compaction",
          ),
        ).toHaveLength(1);
        expect(
          finished.frames.filter(
            (frame) =>
              frame.type === "history.record" &&
              frame.record.type === "message" &&
              frame.record.role === "user",
          ),
        ).toHaveLength(0);
        const detail = await app.inject({
          url: `/v1/details/summary/summary:summary?sessionId=${f.agent.sessionId()}`,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          body: { type: "compaction", text: "native summary" },
        });
      }
    } finally {
      await Promise.all(
        sockets.map(async (socket) => {
          const closed = once(socket, "close");
          socket.close();
          await closed;
        }),
      );
      await app.close();
      f.dispose();
    }
  },
);
