import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { runCli } from "./cli.ts";

async function script(source: string) {
  const root = await mkdtemp(join(tmpdir(), "cli-owner-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "child.mjs");
  await writeFile(path, source);
  return path;
}

it("collects separate streams, stdin and exit status in a fresh cwd", async () => {
  const child = await script(`
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), env: process.env.ONLY }));
    process.stderr.write("diagnostic");
    process.exitCode = 7;
  `);
  const result = await runCli([child], {
    command: process.execPath,
    env: { ONLY: "isolated" },
    input: "π\n",
  });
  expect(result.code).toBe(7);
  expect(result.stderr).toBe("diagnostic");
  const body = JSON.parse(result.stdout);
  expect(body.input).toBe("π\n");
  expect(body.env).toBe("isolated");
  expect(body.cwd).not.toBe(process.cwd());
  const { access } = await import("node:fs/promises");
  await expect(access(body.cwd)).rejects.toThrow();
});

it("reaps a held child before reporting its deadline", async () => {
  const child = await script(
    "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);",
  );
  const failure = await runCli([child], { command: process.execPath, timeoutMs: 200 }).then(
    () => undefined,
    (error: Error & { pid: number }) => error,
  );
  expect(failure?.message).toBe("CLI deadline exceeded");
  expect(failure?.pid).toEqual(expect.any(Number));
  if (!failure) throw new Error("expected deadline failure");
  expect(() => process.kill(failure.pid, 0)).toThrow();
});

it("bounds output and joins termination", async () => {
  const child = await script(
    'process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000);',
  );
  await expect(
    runCli([child], { command: process.execPath, maxOutputBytes: 1000 }),
  ).rejects.toThrow("CLI output exceeded");
});

it("owns spawn failure cleanup", async () => {
  await expect(runCli([], { command: "/missing/owned-cli" })).rejects.toThrow("CLI launch failed");
});
