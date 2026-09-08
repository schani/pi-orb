import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { RUNTIME_SUBPROTOCOL, TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import WebSocket from "ws";
import { api, FatalProbeError, waitFor } from "../harness.ts";

const root = process.env.NATIVE_VM_EVIDENCE ?? ".context/native-vm";
const f = JSON.parse(readFileSync(`${root}/fixture.json`, "utf8"));
const base = "http://127.0.0.1:18100";
await waitFor(
  "native orb running",
  async () => {
    const { body } = await api(base, "GET", `/api/v1/orbs/${f.orbId}`);
    if (body.state === "failed") throw new FatalProbeError(JSON.stringify(body));
    return body.state === "running" ? true : null;
  },
  { timeoutMs: 240000 },
);
if (f.runtimeUrl)
  await waitFor("idle runtime before a new submission", async () => {
    const health = await fetch(`${f.runtimeUrl}/v1/health`).then((r) => r.json());
    return health.status === "ready" && health.activity === "idle" ? true : null;
  });
const frames = [];
process.on("exit", () =>
  writeFileSync(`${root}/protocol-frames.json`, JSON.stringify(frames, null, 2)),
);
const ws = new WebSocket(`ws://127.0.0.1:18100/api/v1/orbs/${f.orbId}/live`, [RUNTIME_SUBPROTOCOL]);
ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
ws.send(
  JSON.stringify({
    v: 1,
    type: "client.hello",
    clientInstanceId: randomUUID(),
    afterRecordId: null,
  }),
);
const sync = await waitFor(
  "sync completed",
  async () => frames.find((x) => x.type === "sync.completed") ?? null,
);
let head = sync.headId;
for (const frame of frames) if (frame.type === "history.record") head = frame.record.id;
const requestId = randomUUID();
const submissionStart = frames.length;
ws.send(
  JSON.stringify({
    v: 1,
    type: "client.request",
    requestId,
    action: {
      type: "message",
      expectedHeadId: head,
      content: [{ type: "text", text: "please run the native VM tool check" }],
    },
  }),
);
const response = await waitFor(
  "request result",
  async () => frames.find((x) => x.type === "request.result" && x.requestId === requestId) ?? null,
);
writeFileSync(`${root}/request-result.json`, JSON.stringify(response, null, 2));
assert.equal(response.result.type, "accepted", JSON.stringify(response));
await waitFor(
  "tool and final history",
  async () =>
    frames
      .slice(submissionStart)
      .some(
        (x) =>
          x.type === "history.record" && JSON.stringify(x).includes("Native VM tool succeeded."),
      )
      ? true
      : null,
  { timeoutMs: 180000 },
);
assert(
  frames
    .slice(submissionStart)
    .some(
      (x) =>
        x.type === "runtime.event" &&
        x.event.type === "tool_state" &&
        x.event.state === "completed",
    ),
);
writeFileSync(`${root}/protocol-frames.json`, JSON.stringify(frames, null, 2));
ws.close();
const terminal = new WebSocket(`ws://127.0.0.1:18100/api/v1/orbs/${f.orbId}/terminal`, [
  TERMINAL_SUBPROTOCOL,
]);
let output = "";
terminal.on("message", (data, binary) => {
  if (binary) output += data.toString();
  else if (JSON.parse(data.toString()).type === "terminal.ready")
    terminal.send(Buffer.from('printf "NATIVE_PTY_%s\\n" OK\r'));
});
await new Promise((resolve, reject) => {
  terminal.once("open", resolve);
  terminal.once("error", reject);
});
terminal.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 100, rows: 30 }));
await waitFor("native terminal", async () => (output.includes("NATIVE_PTY_OK") ? true : null));
terminal.close();
writeFileSync(`${root}/terminal-output.txt`, output);
console.log("NATIVE_PROTOCOL_AND_PTY_OK");
