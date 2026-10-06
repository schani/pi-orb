import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { runTerminal } from "./terminal-client.ts";

it("runs a command only after ready and returns committed terminal output", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const commands: string[] = [];
  sockets.on("connection", (socket) =>
    socket.on("message", (data, binary) => {
      if (binary) {
        commands.push(data.toString());
        socket.send(Buffer.from("identity DONE"));
      } else socket.send(JSON.stringify({ v: 1, type: "terminal.ready" }));
    }),
  );
  try {
    expect(
      await runTerminal(`http://127.0.0.1:${address.port}`, "child", "pi-orb self", "DONE"),
    ).toBe("identity DONE");
    expect(commands).toEqual(["pi-orb self\r"]);
  } finally {
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("rejects a refused terminal immediately without sending a command", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  let closed!: () => void;
  const closing = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let commands = 0;
  sockets.on("connection", (socket) => {
    socket.on("message", (_data, binary) => {
      if (binary) commands++;
    });
    socket.once("close", closed);
    socket.close(1013, "orb is not running");
  });
  vi.useFakeTimers();
  try {
    const outcome = runTerminal(
      `http://127.0.0.1:${address.port}`,
      "child",
      "pi-orb self",
      "DONE",
    ).then(
      () => "resolved",
      (error) => String(error),
    );
    await closing;
    const result = await Promise.race([outcome, Promise.resolve("pending")]);
    expect(result).toContain("1013");
    expect(result).toContain("orb is not running");
    expect(result).toContain("child");
    expect(result).toContain("ready=false");
    expect(commands).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
