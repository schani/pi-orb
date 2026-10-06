import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { resourceError } from "../../domain/resources.ts";
import { command, GitResourceSource } from "./git.ts";

it("cancels the Git process group and waits for helper pipe closure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resource-command-"));
  const socket = join(dir, "ready.sock");
  const controller = new AbortController();
  let helperPid = 0;
  let groupSignalled = false;
  const kill = process.kill.bind(process);
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    groupSignalled ||= pid < 0;
    return kill(pid, signal);
  });
  const server = createServer((connection) => {
    let report = "";
    connection.on("data", (data) => {
      report += data.toString();
    });
    connection.once("end", () => {
      const [helper, leader] = report.split(",").map(Number);
      helperPid = helper ?? 0;
      controller.abort();
      // Failure cleanup while the connected helper still owns the known process group.
      if (!groupSignalled && leader && leader !== process.pid) kill(-leader, "SIGKILL");
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await writeFile(
      join(dir, "git"),
      `#!${process.execPath}\n
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', \`const net = require('node:net');
const connection = net.connect(process.env.READY_SOCKET, () => connection.end(process.pid + ',' + process.ppid));
process.stdout.write('helper-ready');
setInterval(() => {}, 1000);\`], { stdio: ['ignore', 'inherit', 'inherit'] });
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const result = await command(
      ["fetch"],
      dir,
      { PATH: dir, READY_SOCKET: socket },
      controller.signal,
    );
    expect(result.isErr() && result.error.code).toBe("cancelled");
    // A surviving helper holds stdout open, preventing command completion.
    expect(helperPid).toBeGreaterThan(0);
    expect(groupSignalled).toBe(true);
  } finally {
    killSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("terminates an in-flight fetch when the pack monitor reports excess", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resource-command-"));
  const socket = join(dir, "ready.sock");
  let ready!: () => void;
  const barrier = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let connection: Socket | undefined;
  const server = createServer((client) => {
    connection = client;
    client.once("data", ready);
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await writeFile(
      join(dir, "git"),
      `#!${process.execPath}\n
const connection = require('node:net').connect(process.env.READY_SOCKET, () => connection.write('fetch-active'));
connection.on('data', () => process.exit(0));
`,
      { mode: 0o755 },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const inspect = vi
      .fn()
      .mockImplementationOnce(() => okAsync(0))
      .mockImplementation(() => okAsync(128 * 1024 * 1024 + 1));
    const pending = command(
      ["fetch"],
      dir,
      { PATH: dir, READY_SOCKET: socket },
      new AbortController().signal,
      undefined,
      inspect,
    );
    await barrier;
    await vi.advanceTimersByTimeAsync(100);
    connection?.end("finish");
    const result = await pending;
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(result.isErr() && result.error.code).toBe("limit");
    expect(result.isErr() && result.error.message).toBe("Resource Git pack limit exceeded (fetch)");
  } finally {
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  ["process.exit(23)", "exit=23"],
  ["process.kill(process.pid, 'SIGTERM')", "signal=SIGTERM"],
])("reports only fixed stage and exit/signal metadata: %s", async (exit, reason) => {
  const dir = await mkdtemp(join(tmpdir(), "resource-command-"));
  try {
    await writeFile(
      join(dir, "git"),
      `#!${process.execPath}\nprocess.stderr.write('https://secret:token@example.invalid/private/path'); ${exit};`,
      { mode: 0o755 },
    );
    const result = await command(
      ["fetch", "https://private.invalid/repo"],
      dir,
      { PATH: dir },
      new AbortController().signal,
    );
    expect(result.isErr() && result.error.message).toBe(
      `Git resource operation failed (fetch; ${reason})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("maps asynchronous spawn errors without leaking OS paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resource-command-"));
  try {
    const result = await command(["fetch"], dir, { PATH: dir }, new AbortController().signal);
    expect(result.isErr() && result.error.code).toBe("fetch");
    expect(result.isErr() && result.error.message).toBe(
      "Git resource operation failed (fetch; spawn)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves authentication failure and cancels before invoking credentials", async () => {
  const environment = vi.fn(() =>
    errAsync(resourceError("authentication", "Authentication unavailable")),
  );
  const source = new GitResourceSource({ environment });
  const input = {
    orbId: "orb",
    url: "https://github.com/acme/repo",
    signal: new AbortController().signal,
  };
  const failed = await source.acquire(input);
  expect(failed.isErr() && failed.error.code).toBe("authentication");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await source.acquire({ ...input, signal: controller.signal });
  expect(cancelled.isErr() && cancelled.error.code).toBe("cancelled");
  expect(environment).toHaveBeenCalledTimes(1);
});
it("acquires a pinned local commit and follows skill-directory symlinks without checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resource-fixture-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
        stdio: "pipe",
      });
    git("init", "-b", "main");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.invalid");
    await mkdir(join(dir, ".claude/skills/a"), { recursive: true });
    await mkdir(join(dir, ".agents/skills"), { recursive: true });
    await writeFile(join(dir, "CLAUDE.md"), "repository instructions");
    await symlink("CLAUDE.md", join(dir, "AGENTS.md"));
    await writeFile(
      join(dir, ".claude/skills/a/SKILL.md"),
      "---\nname: a\ndescription: test\n---\nbody",
    );
    await writeFile(join(dir, ".claude/skills/a/asset.bin"), Buffer.from([0, 255]));
    await symlink("../../.claude/skills/a", join(dir, ".agents/skills/a"));
    git("add", ".");
    git("commit", "-m", "fixture");
    const sha = git("rev-parse", "HEAD").toString().trim();
    const source = new GitResourceSource({ environment: () => okAsync({}) }, true);
    const r = await source.acquire({
      orbId: "orb",
      url: pathToFileURL(dir).href,
      signal: new AbortController().signal,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.commitSha).toBe(sha);
      expect(r.value.files.find((f) => f.path === ".agents/skills/a/asset.bin")?.bytes).toEqual(
        Buffer.from([0, 255]),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
