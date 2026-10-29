import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import {
  CALLBACK_LIMIT_MESSAGE,
  MAX_CALLBACK_ARGUMENT_BYTES,
  MAX_CALLBACK_CALLS,
  MAX_CALLBACK_CONCURRENCY,
  MAX_CALLBACK_REPLY_BYTES,
  OUTPUT_LIMIT_MESSAGE,
} from "./callback-limits.js";
import { createCpuCheckpoint } from "./cpu-checkpoint.js";

const cpuCheckpoint = createCpuCheckpoint({
  ...workerData.extension,
  interrupt: workerData.interrupt,
});
// [current, peak] V8 heap + external + owned QuickJS wasm capacity (omitted by Node 26).
const memory = new Float64Array(workerData.extension?.memoryStats ?? new SharedArrayBuffer(16));
workerData.checkpoint = () => {
  const heap = getHeapStatistics();
  memory[0] = heap.used_heap_size + heap.external_memory + (workerData.getWasmMemoryBytes?.() ?? 0);
  if (memory[0] > memory[1]) memory[1] = memory[0];
  return cpuCheckpoint();
};
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
let replyBytes = 0;
const outstanding = new Set();
const fail = (message) => {
  stopped = true;
  Atomics.store(new Int32Array(workerData.interrupt), 0, 1);
  post({ type: "crash", message });
};
// Release only when the worker receives a reply, not when the host sends it.
parentPort.on("message", (message) => {
  workerData.checkpoint();
  if (message.type === "result") {
    replyBytes +=
      Buffer.byteLength(message.payload ?? "", "utf8") +
      Buffer.byteLength(message.properties ?? "", "utf8");
    if (replyBytes > MAX_CALLBACK_REPLY_BYTES) fail(CALLBACK_LIMIT_MESSAGE);
    outstanding.delete(message.id);
  }
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
      fail(CALLBACK_LIMIT_MESSAGE);
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
      fail(OUTPUT_LIMIT_MESSAGE);
      return;
    }
  }
  post(message, ...args);
};
await import("@earendil-works/pi-codemode/worker");
