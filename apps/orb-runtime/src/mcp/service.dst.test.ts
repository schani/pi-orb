import { NoSimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { McpConnection, type McpTransport } from "./service.ts";

describe("MCP connection ownership DST", () => {
  it("serializes concurrent calls, closes once, and refuses work after shutdown", async () => {
    await runDst({ name: "mcp-connection-ownership", iterations: 40 }, async (sim) => {
      const run = await sim.runTasks([
        {
          name: "scenario",
          f: async (task) => {
            let connected = 0;
            let closed = 0;
            let active = 0;
            let calls = 0;
            const transport: McpTransport = {
              connect: async (t) => {
                await t.checkpoint("connect");
                connected++;
                return ok({
                  perform: async (t, operation) => {
                    active++;
                    expect(active).toBe(1);
                    await t.checkpoint("remote call accepted");
                    calls++;
                    active--;
                    return ok({ content: [{ type: "text", text: operation.method }] });
                  },
                  close: async () => {
                    expect(active).toBe(0);
                    closed++;
                    return ok(undefined);
                  },
                });
              },
            };
            const connection = new McpConnection(task, transport);
            const a = connection.perform({ method: "tools/call", name: "write", arguments: {} });
            const b = connection.perform({ method: "tools/call", name: "write", arguments: {} });
            const results = await Promise.all([a, b]);
            expect(results.every((r) => r.isOk())).toBe(true);
            expect(connected).toBe(1);
            expect(calls).toBe(2);
            await Promise.all([connection.close(), connection.close()]);
            expect(closed).toBe(1);
            expect((await connection.perform({ method: "catalog" })).isErr()).toBe(true);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });

  it("fences connect completion racing shutdown and never replays an ambiguous write", async () => {
    await runDst({ name: "mcp-connect-close", iterations: 40 }, async (sim) => {
      const run = await sim.runTasks([
        {
          name: "scenario",
          f: async (task) => {
            let opened = 0;
            let closed = 0;
            let calls = 0;
            const transport: McpTransport = {
              connect: async (t) => {
                await t.checkpoint("late connect");
                opened++;
                return ok({
                  perform: async (t) => {
                    calls++;
                    await t.checkpoint("response lost after write");
                    return err({
                      type: "mcp_error",
                      code: "unavailable",
                      message: "MCP request failed; outcome may be unknown",
                    });
                  },
                  close: async () => {
                    closed++;
                    return ok(undefined);
                  },
                });
              },
            };
            const connection = new McpConnection(task, transport);
            const pending = connection.perform({ method: "catalog" });
            await task.checkpoint("shutdown races connect");
            await connection.close();
            expect((await pending).isErr()).toBe(true);
            expect(closed).toBe(opened);
            expect(calls).toBeLessThanOrEqual(1);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });

  it("schedules independent callers, cancellation, and shutdown without leaking sessions or replaying writes", async () => {
    await runDst({ name: "mcp-independent-actors", iterations: 100 }, async (sim) => {
      let opened = 0;
      let closed = 0;
      let active = 0;
      const accepted = new Map<string, number>();
      const controller = new AbortController();
      const transport: McpTransport = {
        connect: async (task) => {
          await task.sleep(task.random("connect delay") * 5, "connect accepted");
          opened++;
          return ok({
            perform: async (task, op) => {
              active++;
              expect(active).toBe(1);
              if (op.method === "tools/call")
                accepted.set(op.name, (accepted.get(op.name) ?? 0) + 1);
              await task.sleep(
                task.random("write delay") * 5,
                "write accepted, response may be lost",
              );
              active--;
              return err({ type: "mcp_error", code: "unavailable", message: "Outcome unknown" });
            },
            close: async () => {
              expect(active).toBe(0);
              closed++;
              return ok(undefined);
            },
          });
        },
      };
      const connection = new McpConnection(
        new NoSimulationTask("unused fallback", false),
        transport,
      );
      const run = await sim.runTasks([
        ...["a", "b"].map((name) => ({
          name,
          f: async (task: import("determined").SimulationTask) => {
            await task.checkpoint("request arrival");
            expect(
              (
                await connection.perform(
                  { method: "tools/call", name, arguments: {} },
                  controller.signal,
                  task,
                )
              ).isErr(),
            ).toBe(true);
          },
        })),
        {
          name: "cancel",
          f: async (task) => {
            await task.sleep(task.random("cancel delay") * 15, "cancel arrival");
            controller.abort();
          },
        },
        {
          name: "shutdown",
          f: async (task) => {
            await task.sleep(task.random("shutdown delay") * 15, "shutdown arrival");
            await connection.close();
          },
        },
      ]);
      if (run.isErr()) throw run.error;
      await connection.close();
      expect(opened).toBe(closed);
      expect([...accepted.values()].every((count) => count === 1)).toBe(true);
    });
  });
});
