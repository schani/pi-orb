import { existsSync } from "node:fs";

const root = process.env.VITEST_RPC_REPRO;
const index = process.argv[2];
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(`${root}/release-${index}`)) Atomics.wait(sleep, 0, 0, 10);
