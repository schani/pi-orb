// Survives page reloads; posts its pending log whenever the preview answers again.
const key = "preview-monitor";
const events = JSON.parse(localStorage.getItem(key) ?? "[]");
const out = document.getElementById("out");
let posted = Number(localStorage.getItem(`${key}-posted`) ?? 0);
const record = (event) => {
  events.push({ at: new Date().toISOString(), ...event });
  localStorage.setItem(key, JSON.stringify(events));
  out.textContent = events.slice(-40).map((e) => JSON.stringify(e)).join("\n");
};
record({ type: "page_load" });
let socket;
const open = () => {
  socket = new WebSocket(location.origin.replace("https:", "wss:") + "/__ws");
  socket.onopen = () => record({ type: "ws_open" });
  socket.onclose = (e) => {
    record({ type: "ws_close", code: e.code, reason: e.reason });
    setTimeout(open, 2000);
  };
};
open();
let previous = null;
setInterval(async () => {
  const started = performance.now();
  const outcome = await fetch(`/__cookie?probe=${Date.now()}`, { cache: "no-store" }).then(
    (r) => `${r.status} ${r.headers.get("x-pi-orb-preview-error") ?? ""}`.trim(),
    (e) => `network ${e.name}`,
  );
  const ms = Math.round(performance.now() - started);
  if (outcome !== previous) record({ type: "probe_change", outcome, ms });
  previous = outcome;
  if (outcome.startsWith("200") && events.length > posted) {
    const body = JSON.stringify(events.slice(posted));
    const ok = await fetch("/__monitor", { method: "POST", body }).then((r) => r.ok, () => false);
    if (ok) {
      posted = events.length;
      localStorage.setItem(`${key}-posted`, String(posted));
    }
  }
}, 1000);
