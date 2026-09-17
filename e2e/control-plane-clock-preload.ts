import { performance } from "node:perf_hooks";
import { NoSimulationTask } from "determined";

const epoch = Number(process.env["PI_ORB_E2E_CLOCK_EPOCH_MS"]);
const started = performance.now();
let offset = 0;

const effectiveNow = (): number => epoch + (performance.now() - started) + offset;

if (!Number.isFinite(epoch)) {
  process.send?.({ type: "pi-orb.clock.ready", error: "invalid_epoch" });
} else {
  NoSimulationTask.prototype.wallNow = effectiveNow;
  process.send?.({ type: "pi-orb.clock.ready", now: effectiveNow() });

  process.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "pi-orb.clock.advance" ||
      !("id" in message) ||
      typeof message.id !== "number" ||
      !("target" in message) ||
      typeof message.target !== "number"
    ) {
      return;
    }
    const now = effectiveNow();
    if (!Number.isFinite(message.target)) {
      process.send?.({ type: "pi-orb.clock.result", id: message.id, error: "invalid_target" });
      return;
    }
    if (message.target < now) {
      process.send?.({ type: "pi-orb.clock.result", id: message.id, error: "rollback", now });
      return;
    }
    offset += message.target - now;
    process.send?.({ type: "pi-orb.clock.result", id: message.id, now: effectiveNow() });
  });
}
