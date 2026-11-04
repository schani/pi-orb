import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { WebSocketServer } from "ws";

const dir = process.env.ACCEPT_DIR ?? "/tmp/accept";
const log = (line) => appendFileSync(`${dir}/events.log`, `${new Date().toISOString()} ${line}\n`);

function acceptance() {
  return {
    name: "acceptance",
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });
      server.httpServer.on("upgrade", (req, socket, head) => {
        if (!req.url.startsWith("/__ws")) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          log(`ws open ${req.headers.host}`);
          ws.on("message", (data, binary) => ws.send(data, { binary }));
          ws.on("close", (code) => log(`ws close ${code}`));
        });
      });
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, "http://x");
        const p = url.pathname;
        if (p === "/__cookie") {
          res.setHeader("set-cookie", "acceptance=app-cookie; Path=/; Secure; SameSite=Lax");
          return res.end(JSON.stringify({ received: req.headers.cookie ?? "", host: req.headers.host, proto: req.headers["x-forwarded-proto"] ?? null }));
        }
        if (p === "/__upload") {
          const hash = createHash("sha256"); let bytes = 0;
          req.on("data", (c) => { bytes += c.length; hash.update(c); });
          req.on("end", () => res.end(JSON.stringify({ bytes, sha256: hash.digest("hex") })));
          return;
        }
        if (p === "/__download") {
          const total = Number(url.searchParams.get("mb")) * 1024 * 1024; const chunk = Buffer.alloc(1024 * 1024, 7); let sent = 0;
          res.setHeader("content-type", "application/octet-stream");
          const pump = () => { while (sent < total) { sent += chunk.length; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
          return pump();
        }
        if (p === "/__sse") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          let n = 0; const seconds = Number(url.searchParams.get("seconds") ?? 3);
          res.write(`data: first\n\n`);
          const t = setInterval(() => { n++; res.write(`data: tick ${n}\n\n`); if (n >= seconds) { clearInterval(t); res.end("data: end\n\n"); } }, 1000);
          req.on("close", () => clearInterval(t));
          return;
        }
        if (p === "/__touch") {
          // Pushes over Vite's own HMR WebSocket, the channel dev-server updates use.
          server.ws.send({ type: "custom", event: "acceptance:push", data: { v: url.searchParams.get("v") } });
          return res.end("ok");
        }
        if (p === "/__revoke") {
          log("revoke requested");
          spawn("sh", ["-c", "sleep 1; pi-orb unexpose 5173 && echo unexposed >> /tmp/accept/events.log; sleep 20; pi-orb expose 5173 >> /tmp/accept/events.log 2>&1"], { detached: true, stdio: "ignore" }).unref();
          return res.end("ok");
        }
        if (p === "/__monitor") {
          let body = ""; req.on("data", (c) => { body += c; });
          req.on("end", () => { appendFileSync(`${dir}/monitor.jsonl`, `${body}\n`); res.end("ok"); });
          return;
        }
        if (p === "/__results") {
          let body = ""; req.on("data", (c) => { body += c; });
          req.on("end", () => { writeFileSync(`${dir}/results.json`, body); log("results received"); res.end("ok"); });
          return;
        }
        next();
      });
    },
  };
}

export default {
  plugins: [acceptance()],
  server: { allowedHosts: [".piorb.live"], hmr: process.env.LOCAL ? {} : { clientPort: 443 } },
};
