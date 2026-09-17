import { spawn } from "node:child_process";
import { NoSimulationTask } from "determined";

if (process.env["PI_ORB_CLOCK_PROBE_CHILD"] === "1") {
  process.send?.({
    type: "pi-orb.runtime-clock.result",
    now: new NoSimulationTask("runtime clock probe", true).wallNow(),
  });
} else {
  process.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "pi-orb.runtime-clock.probe" ||
      !("id" in message) ||
      typeof message.id !== "number"
    ) {
      return;
    }
    const child = spawn("node", [import.meta.filename], {
      env: { ...process.env, PI_ORB_CLOCK_PROBE_CHILD: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.once("message", (childMessage: unknown) => {
      const now =
        typeof childMessage === "object" &&
        childMessage !== null &&
        "now" in childMessage &&
        typeof childMessage.now === "number"
          ? childMessage.now
          : Number.NaN;
      process.send?.({ type: "pi-orb.runtime-clock.result", id: message.id, now });
      child.disconnect();
    });
  });
}
