// Throwaway validation server for DESIGN.md §3.6 / open question 2.
// Runs on Cloud Run (browser-leg test) and on a COS VM (VPC-egress target).
//
//   GET  /            → status text
//   WS   /ws          → hello frame, then a tick frame every 15 s; echoes input
//   POST /vm-probe?url=ws://HOST:PORT/ws
//                     → this instance opens an outbound WS to the given URL
//                       and holds it (tests Direct VPC egress from Cloud Run)
//   GET  /vm-probe    → JSON status of the outbound probe
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 8080);
const startedAt = Date.now();

const probe = {
  url: null,
  connectedAt: null,
  lastTickAt: null,
  ticks: 0,
  closes: [],
  socket: null,
};

function startProbe(url) {
  probe.url = url;
  const socket = new WebSocket(url);
  probe.socket = socket;
  socket.on("open", () => {
    probe.connectedAt = Date.now();
  });
  socket.on("message", () => {
    probe.lastTickAt = Date.now();
    probe.ticks += 1;
  });
  socket.on("close", (code, reason) => {
    probe.closes.push({
      at: new Date().toISOString(),
      afterSeconds:
        probe.connectedAt === null ? null : Math.round((Date.now() - probe.connectedAt) / 1000),
      code,
      reason: reason.toString(),
    });
    probe.connectedAt = null;
    // Reconnect so we can measure repeated lifetimes overnight.
    setTimeout(() => startProbe(url), 2000);
  });
  socket.on("error", (error) => {
    probe.closes.push({ at: new Date().toISOString(), error: String(error) });
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/vm-probe") {
    const target = url.searchParams.get("url");
    if (target === null) {
      res.writeHead(400).end("missing url param\n");
      return;
    }
    probe.socket?.terminate();
    probe.closes.length = 0;
    probe.ticks = 0;
    startProbe(target);
    res.writeHead(202).end(`probing ${target}\n`);
    return;
  }
  if (url.pathname === "/vm-probe") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        {
          url: probe.url,
          connected: probe.connectedAt !== null,
          connectionAgeSeconds:
            probe.connectedAt === null ? null : Math.round((Date.now() - probe.connectedAt) / 1000),
          ticks: probe.ticks,
          lastTickAt: probe.lastTickAt === null ? null : new Date(probe.lastTickAt).toISOString(),
          closes: probe.closes,
        },
        null,
        2,
      ),
    );
    return;
  }
  res.writeHead(200).end(`ws-validation up ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  const connectedAt = Date.now();
  socket.send(
    JSON.stringify({ type: "hello", serverStartedAt: new Date(startedAt).toISOString() }),
  );
  const timer = setInterval(() => {
    socket.send(
      JSON.stringify({
        type: "tick",
        ageSeconds: Math.round((Date.now() - connectedAt) / 1000),
      }),
    );
  }, 15_000);
  socket.on("message", (data) => socket.send(data.toString()));
  socket.on("close", () => clearInterval(timer));
});

server.listen(port, () => console.log(`listening on ${port}`));
