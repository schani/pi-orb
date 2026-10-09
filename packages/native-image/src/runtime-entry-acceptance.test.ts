import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Result, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";

it("native acceptance exports only its fixed failure code and source line", async () => {
  const acceptance = readFileSync(
    new URL("../../../infra/native-vm/acceptance.sh", import.meta.url),
    "utf8",
  );
  const trap = acceptance.match(/^trap (.+) ERR$/mu)?.[1];
  expect(trap).toBeDefined();
  const failed = await ResultAsync.fromPromise(
    promisify(execFile)("bash", ["-c", `set -e; trap ${trap} ERR; false`]),
    (cause) => ({ stderr: (cause as { stderr?: string }).stderr }),
  );
  expect(failed.isErr()).toBe(true);
  if (failed.isErr()) expect(failed.error.stderr).toMatch(/^native_acceptance_failed line=\d+\n$/u);
});

it("native acceptance identifies the actual supervised runtime entry child", async () => {
  const supervisor = readFileSync(
    new URL("../../../apps/orb-runtime/src/supervisor/adapters.ts", import.meta.url),
    "utf8",
  );
  const entry = supervisor.match(/const RUNTIME = \["\/usr\/local\/bin\/node", "([^"]+)"\]/u)?.[1];
  expect(entry).toBeDefined();
  const acceptance = readFileSync(
    new URL("../../../infra/native-vm/acceptance.sh", import.meta.url),
    "utf8",
  );
  expect(acceptance).toContain("native_acceptance_failed line=%s");
  const pattern = acceptance.match(
    /pgrep --parent "\$runtime_supervisor_pid" --full '([^']+)'/u,
  )?.[1];
  expect(pattern).toBeDefined();
  const started = Result.fromThrowable(
    () =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.title = '/usr/local/bin/node ${entry}'; process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    () => "spawn failed",
  )();
  expect(started.isOk()).toBe(true);
  if (started.isErr()) return;
  const child = started.value;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const ready = await new Promise<boolean>((resolve) => {
      child.stdout.once("data", () => resolve(true));
      child.once("error", () => resolve(false));
      child.once("close", () => resolve(false));
    });
    expect(ready).toBe(true);
    const matched = await ResultAsync.fromPromise(
      promisify(execFile)(
        "pgrep",
        process.platform === "darwin"
          ? ["-P", String(process.pid), "-f", pattern ?? ""]
          : ["--parent", String(process.pid), "--full", pattern ?? ""],
      ),
      () => "runtime entry not matched",
    );
    expect(matched.isOk()).toBe(true);
    if (matched.isOk()) expect(matched.value.stdout.trim()).toBe(String(child.pid));
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
