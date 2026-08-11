import { once } from "node:events";
import type { AddressInfo } from "node:net";
import websocketPlugin from "@fastify/websocket";
import { TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  type PtyFactory,
  type PtyProcess,
  TerminalManager,
  type TerminalProcessExit,
} from "../terminal/manager.ts";
import { registerTerminalRoute } from "./terminal-route.ts";

class FakeProcess implements PtyProcess {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private resolveKilled: () => void = () => undefined;
  readonly killedPromise = new Promise<void>((resolve) => {
    this.resolveKilled = resolve;
  });
  dataListener: (data: string) => void = () => undefined;
  exitListener: (exit: TerminalProcessExit) => void = () => undefined;
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    this.resolveKilled();
  }
  onData(listener: (data: string) => void): () => void {
    this.dataListener = listener;
    return () => undefined;
  }
  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    this.exitListener = listener;
    return () => undefined;
  }
}

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup(ready = true) {
  const process = new FakeProcess();
  const factory: PtyFactory = { open: () => okAsync(process) };
  const manager = new TerminalManager({ cwd: "/repo", factory });
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(websocketPlugin, {
    options: {
      handleProtocols: (protocols) =>
        protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false,
    },
  });
  registerTerminalRoute(app, { isReady: () => ready, manager });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/terminal`, TERMINAL_SUBPROTOCOL);
  await once(socket, "open");
  return { process, manager, socket };
}

function nextMessage(socket: WebSocket): Promise<[Buffer, boolean]> {
  return new Promise((resolve) =>
    socket.once("message", (data, isBinary) => resolve([Buffer.from(data as Buffer), isBinary])),
  );
}

describe("runtime terminal route", () => {
  it("opens a PTY, forwards binary input/output, and resizes it", async () => {
    const { process, socket } = await setup();
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 80, rows: 24 }));
    expect(JSON.parse((await ready)[0].toString())).toEqual({
      v: 1,
      type: "terminal.ready",
      cols: 80,
      rows: 24,
    });

    socket.send(Buffer.from("echo hello\r"));
    await until(() => process.writes.length === 1);
    expect(process.writes).toEqual(["echo hello\r"]);

    const output = nextMessage(socket);
    process.dataListener("hello\r\n");
    const [data, binary] = await output;
    expect(binary).toBe(true);
    expect(data.toString()).toBe("hello\r\n");

    socket.send(JSON.stringify({ v: 1, type: "terminal.resize", cols: 132, rows: 41 }));
    await until(() => process.resizes.length === 1);
    expect(process.resizes).toEqual([[132, 41]]);
    const clientClosed = once(socket, "close");
    const processKilled = process.killedPromise;
    socket.close();
    await Promise.all([clientClosed, processKilled]);
    expect(process.killed).toBe(true);
  });

  it("rejects opening before runtime readiness", async () => {
    const { socket } = await setup(false);
    const response = nextMessage(socket);
    socket.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 80, rows: 24 }));
    const control = JSON.parse((await response)[0].toString());
    expect(control.type).toBe("terminal.error");
    expect(control.error.code).toBe("not_ready");
    socket.terminate();
  });
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
