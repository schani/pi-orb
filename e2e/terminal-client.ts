import { TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import WebSocket from "ws";

/** Fixture failures reject so Vitest reports the calling test's transport evidence. */
export async function runTerminal(
  baseUrl: string,
  orbId: string,
  command: string,
  until: string,
): Promise<string> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/v1/orbs/${orbId}/terminal`, [
    TERMINAL_SUBPROTOCOL,
  ]);
  let output = "";
  let ready = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const failure = (kind: string, detail: string) =>
        new Error(
          `terminal ${kind}: orb=${orbId} ready=${ready} ${detail} output=${JSON.stringify(output.slice(-4000))}`,
        );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("open");
        socket.removeAllListeners("message");
        if (error) reject(error);
        else resolve(output);
      };
      const timer = setTimeout(() => finish(failure("timeout", command)), 30_000);
      socket.once("open", () =>
        socket.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 200, rows: 30 })),
      );
      socket.once("close", (code, reason) =>
        finish(failure("closed", `code=${code} reason=${reason.toString()}`)),
      );
      socket.on("error", (error) => finish(failure("error", error.message)));
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          output += data.toString();
          if (output.includes(until)) finish();
          return;
        }
        try {
          const control = JSON.parse(data.toString()) as {
            type?: string;
            error?: { message?: string };
          };
          if (control.type === "terminal.ready") {
            ready = true;
            socket.send(Buffer.from(`${command}\r`));
          } else if (control.type === "terminal.error")
            finish(failure("error", control.error?.message ?? "terminal error"));
        } catch {
          finish(failure("invalid control frame", data.toString().slice(0, 400)));
        }
      });
    });
  } finally {
    if (socket.readyState === WebSocket.CLOSED) socket.removeAllListeners();
    else {
      socket.once("close", () => socket.removeAllListeners());
      socket.close();
    }
  }
}
