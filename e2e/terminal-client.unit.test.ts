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
  let commands = 0;
  sockets.on("connection", (socket) => {
    socket.on("message", (_data, binary) => {
      if (binary) commands++;
    });
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
    // Fake timers hold the 30 s client timeout, so only the close can settle this.
    const result = await outcome;
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

it("routes the owned direct terminal socket with its configured public host", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let host: string | undefined;
  sockets.on("connection", (socket, request) => {
    host = request.headers.host;
    socket.on("message", (_data, binary) => {
      if (binary) socket.send(Buffer.from("DONE"));
      else socket.send(JSON.stringify({ v: 1, type: "terminal.ready" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing owned port");
    expect(
      await runTerminal(`http://127.0.0.1:${address.port}`, "orb", "echo DONE", "DONE", {
        host: "app.example.test",
      }),
    ).toBe("DONE");
    expect(host).toBe("app.example.test");
  } finally {
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
