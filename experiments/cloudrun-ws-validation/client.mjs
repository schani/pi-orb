// Probe client: holds a WebSocket to the given URL, logs every lifecycle
// event with elapsed seconds, reconnects on close, and exits after the
// requested duration. Node 24's global WebSocket, no dependencies.
//
//   node client.mjs wss://HOST/ws <durationSeconds>
const [url, durationArg] = process.argv.slice(2);
if (!url) {
  console.error("usage: node client.mjs <wsUrl> [durationSeconds]");
  process.exit(1);
}
const durationMs = Number(durationArg ?? 3900) * 1000;
const startedAt = Date.now();
const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);
const log = (event, extra = {}) => console.log(JSON.stringify({ t: elapsed(), event, ...extra }));

let connections = 0;

function connect() {
  if (Date.now() - startedAt > durationMs) {
    log("done", { connections });
    process.exit(0);
  }
  connections += 1;
  const openedAt = Date.now();
  const socket = new WebSocket(url);
  socket.onopen = () => log("open", { connection: connections });
  socket.onmessage = (message) => {
    const frame = JSON.parse(message.data);
    if (frame.type !== "tick" || frame.ageSeconds % 60 === 0) log("recv", frame);
  };
  socket.onclose = (event) =>
    log("close", {
      connection: connections,
      afterSeconds: ((Date.now() - openedAt) / 1000).toFixed(1),
      code: event.code,
      reason: event.reason,
    });
  socket.onerror = () => log("error", { connection: connections });
  socket.addEventListener("close", () => setTimeout(connect, 1000));
}

connect();
setTimeout(() => {
  log("done", { connections });
  process.exit(0);
}, durationMs).unref?.();
