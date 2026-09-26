import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runDst } from "../../apps/control-plane/src/testkit/sim.ts";

const root = process.env.VITEST_RPC_REPRO;
const mark = (event, index) =>
  appendFileSync(
    `${root}/events.jsonl`,
    `${JSON.stringify({
      event,
      index,
      pid: process.pid,
      mono: Number(process.hrtime.bigint()) / 1e6,
    })}\n`,
  );
const waiter = fileURLToPath(new URL("./waiter.mjs", import.meta.url));

function gate(index) {
  mark("worker-entered-block", index);
  writeFileSync(`${root}/entered-${index}`, "1");
  execFileSync(process.execPath, [waiter, String(index)], { env: process.env, timeout: 25_000 });
  mark("worker-left-block", index);
}

it("runs the same four bounded child-process intervals", async () => {
  if (process.env.VITEST_RPC_CASE === "actual") {
    let index = 0;
    await runDst({ name: "rpc-worker-host-loop-handoff", iterations: 4 }, async () => {
      gate(index++);
    });
    expect(index).toBe(4);
  } else {
    for (let index = 0; index < 4; index++) {
      gate(index);
      if (process.env.VITEST_RPC_CASE === "handoff")
        await new Promise((resolve) => setImmediate(resolve));
      else await Promise.resolve();
    }
  }
}, 90_000);
