import { parentPort, workerData } from "node:worker_threads";
import {
  CALLBACK_LIMIT_MESSAGE,
  MAX_CALLBACK_ARGUMENT_BYTES,
  MAX_CALLBACK_CALLS,
  MAX_CALLBACK_CONCURRENCY,
} from "./callback-limits.js";
import { createCpuCheckpoint } from "./cpu-checkpoint.js";

workerData.checkpoint = createCpuCheckpoint({
  ...workerData.extension,
  interrupt: workerData.interrupt,
});
workerData.checkpoint();

// The public worker entry uses this port for output. Bound the pipe before the
// upstream host collects messages; the QuickJS heap limit alone cannot do that.
const MAX_TEXT_BYTES = 1024 * 1024;
// The reader accepts 20 MiB images; their base64 representation needs ~27 MiB.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_ITEMS = 4096;
const post = parentPort.postMessage.bind(parentPort);
let bytes = 0;
let textBytes = 0;
let items = 0;
let stopped = false;
let calls = 0;
let argumentBytes = 0;
const outstanding = new Set();
// Release only when the worker receives a reply, not when the host sends it.
parentPort.on("message", (message) => {
  workerData.checkpoint();
  if (message.type === "result") outstanding.delete(message.id);
});
parentPort.postMessage = (message, ...args) => {
  workerData.checkpoint();
  if (stopped) return;
  if (message.type === "call") {
    calls++;
    argumentBytes += Buffer.byteLength(message.args ?? "", "utf8");
    if (
      calls > MAX_CALLBACK_CALLS ||
      argumentBytes > MAX_CALLBACK_ARGUMENT_BYTES ||
      outstanding.size >= MAX_CALLBACK_CONCURRENCY
    ) {
      stopped = true;
      Atomics.store(new Int32Array(workerData.interrupt), 0, 1);
      post({ type: "crash", message: CALLBACK_LIMIT_MESSAGE });
      return;
    }
    outstanding.add(message.id);
  }
  if (message.type === "output") {
    const item = message.item;
    const size = Buffer.byteLength(item.type === "text" ? item.text : item.data, "utf8");
    bytes += size;
    if (item.type === "text") textBytes += size;
    items++;
    if (textBytes > MAX_TEXT_BYTES || bytes > MAX_OUTPUT_BYTES || items > MAX_OUTPUT_ITEMS) {
      stopped = true;
      Atomics.store(new Int32Array(workerData.interrupt), 0, 1);
      post({
        type: "crash",
        message: "Code-mode output limit exceeded (1 MiB text / 32 MiB aggregate / 4096 items)",
      });
      return;
    }
  }
  post(message, ...args);
};
await import("@earendil-works/pi-codemode/worker");
