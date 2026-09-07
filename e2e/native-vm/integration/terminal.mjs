import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import WebSocket from "ws";
import { FatalProbeError, waitFor } from "../../harness.ts";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const f = JSON.parse(readFileSync(`${root}/fixture.json`));
const command = process.argv[2];
const outputPath = process.argv[3];
let output = "";
let closed = false;
const ws = new WebSocket(`ws://127.0.0.1:18100/api/v1/orbs/${f.orbId}/terminal`, [
  TERMINAL_SUBPROTOCOL,
]);
ws.on("close", () => {
  closed = true;
});
process.on("exit", () => writeFileSync(outputPath, output));
ws.on("message", (data, binary) => {
  if (binary) {
    output += data.toString();
    writeFileSync(outputPath, output);
  } else if (JSON.parse(data.toString()).type === "terminal.ready")
    ws.send(Buffer.from(`${command}; printf '\\nNATIVE_RESULT=%s\\n' $?\r`));
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
ws.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 120, rows: 30 }));
const result = await waitFor(
  "terminal command result",
  async () => {
    const result = output.match(/\r?\nNATIVE_RESULT=(\d+)\r?\n/);
    if (!result && closed) throw new FatalProbeError("terminal closed before command result");
    return result;
  },
  { timeoutMs: 600000 },
);
ws.close();
assert.equal(result[1], "0", output);
console.log("TERMINAL_COMMAND_OK");
