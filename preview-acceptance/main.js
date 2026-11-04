const out = document.getElementById("out");
const results = {};
const show = () => { out.textContent = JSON.stringify(results, null, 2); };
const record = (name, ok, detail) => { results[name] = { ok, ...detail }; show(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn) => { const t = performance.now(); const v = await fn(); return [v, Math.round(performance.now() - t)]; };
let current = null;
if (import.meta.hot) import.meta.hot.on("acceptance:push", (data) => { current = data.v; });

async function step(name, fn) {
  try { const detail = await fn(); record(name, detail.ok ?? true, detail); }
  catch (e) { record(name, false, { error: String(e) }); }
}
const wsOpen = (path) => new Promise((resolve, reject) => {
  const ws = new WebSocket(location.origin.replace("https:", "wss:") + path);
  ws.binaryType = "arraybuffer"; ws.onopen = () => resolve(ws); ws.onerror = () => reject(new Error("ws error"));
});

async function run() {
await step("hmr", async () => {
  const v = `hmr-${Date.now()}`;
  await fetch(`/__touch?v=${v}`);
  for (let i = 0; i < 100 && current !== v; i++) await sleep(100);
  return { ok: current === v, value: current };
});
await step("websocket_echo", async () => {
  const ws = await wsOpen("/__ws");
  const text = await new Promise((r) => { ws.onmessage = (e) => r(e.data); ws.send("hello"); });
  const bin = await new Promise((r) => { ws.onmessage = (e) => r(Array.from(new Uint8Array(e.data)).join(",")); ws.send(new Uint8Array([0, 255, 7])); });
  ws.close(); return { ok: text === "hello" && bin === "0,255,7", text, bin };
});
await step("sse_first_byte_before_end", async () => {
  const [first, ms] = await timed(() => new Promise((resolve, reject) => {
    const es = new EventSource("/__sse?seconds=5"); es.onmessage = (e) => { es.close(); resolve(e.data); }; es.onerror = () => { es.close(); reject(new Error("sse error")); };
  }));
  return { ok: first === "first" && ms < 4000, first, ms };
});
await step("cookie_roundtrip", async () => {
  await fetch("/__cookie"); const second = await (await fetch("/__cookie")).json();
  return { ok: second.received.includes("acceptance=app-cookie") && !/pi-orb/i.test(second.received), ...second };
});
for (const mb of [1, 20, 40]) {
  await step(`upload_${mb}mib`, async () => {
    const data = new Uint8Array(mb * 1024 * 1024); for (let i = 0; i < data.length; i += 4096) data[i] = i & 255;
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map((b) => b.toString(16).padStart(2, "0")).join("");
    const [res, ms] = await timed(() => fetch("/__upload", { method: "POST", body: data }));
    if (!res.ok) return { ok: false, status: res.status, error: res.headers.get("x-pi-orb-preview-error"), ms };
    const body = await res.json(); return { ok: body.sha256 === expected, status: res.status, bytes: body.bytes, ms };
  });
}
await step("download_50mib", async () => {
  const [res, ms] = await timed(() => fetch("/__download?mb=50")); const buf = await res.arrayBuffer();
  return { ok: buf.byteLength === 50 * 1024 * 1024, bytes: buf.byteLength, ms };
});
await step("long_stream_70s", async () => {
  const [count, ms] = await timed(() => new Promise((resolve) => {
    let n = 0; const es = new EventSource("/__sse?seconds=70");
    es.onmessage = (e) => { n++; if (e.data === "end") { es.close(); resolve(n); } }; es.onerror = () => { es.close(); resolve(-n); };
  }));
  return { ok: count >= 70, events: count, ms };
});
await step("privacy_marker_request", async () => {
  const res = await fetch(`/?privacy=${"pm-9f14d9dff29d"}`); return { ok: res.ok, status: res.status };
});
await step("revoke_fences_streams_and_requests", async () => {
  const ws = await wsOpen("/__ws");
  const closed = new Promise((r) => { const t = performance.now(); ws.onclose = (e) => r({ code: e.code, ms: Math.round(performance.now() - t) }); });
  await fetch("/__revoke");
  const closeInfo = await Promise.race([closed, sleep(20000).then(() => null)]);
  let denied = null;
  for (let i = 0; i < 20 && denied === null; i++) { const r = await fetch(`/__cookie?probe=${i}`); if (r.status === 404) denied = { status: 404, error: r.headers.get("x-pi-orb-preview-error") }; else await sleep(500); }
  let restored = null;
  for (let i = 0; i < 40 && restored === null; i++) { await sleep(1000); const r = await fetch(`/__cookie?after=${i}`); if (r.ok) restored = { status: r.status, afterSeconds: i + 1 }; }
  return { ok: closeInfo !== null && denied !== null && restored !== null, closeInfo, denied, restored };
});
results.userAgent = navigator.userAgent;
await fetch("/__results", { method: "POST", body: JSON.stringify(results) });
out.textContent = "DONE\n" + JSON.stringify(results, null, 2);
}
run();
