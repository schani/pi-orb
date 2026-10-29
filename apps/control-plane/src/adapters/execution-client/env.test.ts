import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ownerSkillCapturePath } from "@pi-orb/protocol";
import { afterEach, expect, test } from "vitest";
import { RemoteExecutionEnv } from "./env.ts";

const context = (abortSignal?: AbortSignal): Context =>
  abortSignal ? withAbortSignal(abortSignal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
let child: ChildProcess | undefined;
let directory: string | undefined;
let parentDirectory: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (parentDirectory) await rm(parentDirectory, { recursive: true, force: true });
});
async function start() {
  parentDirectory = await realpath(await mkdtemp(join(tmpdir(), "orb-execution-test-")));
  directory = join(parentDirectory, "workspace");
  await mkdir(directory);
  child = spawn(process.execPath, ["apps/orb-runtime/src/execution/test-host.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, EXECUTION_TEST_CWD: directory },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  const [message] = (await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code]) => {
      throw new Error(`execution test host exited ${code}`);
    }),
  ])) as [{ port: number; pid: number }];
  expect(message.pid).not.toBe(process.pid);
  return new RemoteExecutionEnv({
    baseUrl: `http://127.0.0.1:${message.port}`,
    token: "test-token",
    incarnation: "7",
    cwd: directory,
  });
}
test("separate execution process implements filesystem, bounded readers and streamed shell spill", async () => {
  const env = await start();
  const ctx = context();
  expect((await env.writeFile("sample", "one\ntwo\nthree", ctx)).ok).toBe(true);
  expect(await env.readTextLines("sample", { maxLines: 2 }, ctx)).toEqual({
    ok: true,
    value: ["one", "two"],
  });
  const opened = await env.openTextLineReader("sample", ctx);
  expect(opened.ok).toBe(true);
  if (opened.ok) {
    expect(await opened.value.readLine(ctx)).toEqual({
      ok: true,
      value: { text: "one", terminated: true },
    });
    await opened.value.close(ctx);
  }
  const binary = new Uint8Array([0, 255, 12]);
  await env.writeFile("binary", binary, ctx);
  expect(await env.readBinaryFile("binary", ctx)).toEqual({ ok: true, value: binary });
  let output = "";
  const result = await env.exec(
    "printf 'remote\\n'; printf 'effect' > effect",
    {
      spill: { afterBytes: 1, afterLines: 1 },
      onOutput: (text) => {
        output += text;
      },
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(output).toBe("remote\n");
  expect(await env.readTextFile("effect", ctx)).toEqual({ ok: true, value: "effect" });
  if (result.ok) {
    expect(result.value.spillPath).toBeDefined();
    expect(await env.readTextFile(result.value.spillPath!, ctx)).toEqual({
      ok: true,
      value: output,
    });
  }
});
test("command failure preserves both output streams and exit status, unlike transport failure", async () => {
  const env = await start();
  let output = "";
  const result = await env.exec(
    "printf 'stdout detail\\n'; printf 'stderr detail\\n' >&2; exit 23",
    {
      onOutput: (text) => {
        output += text;
      },
    },
    context(),
  );
  expect(result).toEqual({ ok: true, value: { exitCode: 23 } });
  expect(output).toContain("stdout detail\n");
  expect(output).toContain("stderr detail\n");
  const exited = once(child!, "exit");
  child!.kill("SIGTERM");
  await exited;
  const unavailable = await env.exec("echo INPUT_MUST_NOT_LEAK", undefined, context());
  expect(unavailable.ok).toBe(false);
  if (!unavailable.ok) {
    expect(unavailable.error.code).toBe("unknown");
    expect(unavailable.error.message).toBe("execution transport failed; effects may have occurred");
    expect(unavailable.error.message).not.toContain("INPUT_MUST_NOT_LEAK");
  }
});

test("binary and directory readers page remotely; argv exec reports each output stream", async () => {
  const env = await start();
  const ctx = context();
  // Larger than one host response, so reads page and still return exactly the requested range.
  const large = new Uint8Array(1024 * 1024 + 5000).map((_, index) => index % 251);
  await env.writeFile("large.bin", large, ctx);
  await env.writeFile("lines.txt", "one\ntwo\nthree", ctx);
  const opened = await env.openBinaryReader("large.bin", undefined, ctx);
  if (!opened.ok) throw opened.error;
  expect(await opened.value.info(ctx)).toMatchObject({ ok: true, value: { size: large.length } });
  expect(await opened.value.read(10, large.length, ctx)).toEqual({
    ok: true,
    value: large.subarray(10),
  });
  await opened.value.close(ctx);
  expect((await opened.value.info(ctx)).ok).toBe(false);
  const lines = await env.openBinaryReader("lines.txt", { noFollow: true }, ctx);
  if (!lines.ok) throw lines.error;
  expect(await lines.value.scanLines({ startLine: 1, endLine: 2 }, ctx)).toMatchObject({
    ok: true,
    value: { newlines: 2, start: 4, end: 7 },
  });
  await lines.value.close(ctx);
  expect(await env.openBinaryReader(".", undefined, ctx)).toMatchObject({
    ok: false,
    error: { code: "is_directory" },
  });
  const dir = await env.openDirReader(".", ctx);
  if (!dir.ok) throw dir.error;
  const first = await dir.value.next(1, ctx);
  const rest = await dir.value.next(10, ctx);
  expect(first).toMatchObject({ ok: true, value: { done: false } });
  expect(rest).toMatchObject({ ok: true, value: { done: true } });
  expect(
    [first, rest].flatMap((page) => (page.ok ? page.value.entries.map((e) => e.name) : [])).sort(),
  ).toEqual(["large.bin", "lines.txt"]);
  expect(await env.watch([{ path: "." }], () => {}, ctx)).toMatchObject({
    ok: false,
    error: { code: "not_supported" },
  });
  const streams: string[] = [];
  const result = await env.exec(
    ["sh", "-c", "printf out; printf err >&2", "ignored"],
    { onOutput: (text, _ctx, info) => streams.push(`${info.stream}:${text}`) },
    ctx,
  );
  expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
  expect(streams.sort()).toEqual(["stderr:err", "stdout:out"]);
});

test("filesystem capability includes metadata, mutation and temporary files", async () => {
  const env = await start();
  const ctx = context();
  expect((await env.createDir("nested", { recursive: true }, ctx)).ok).toBe(true);
  expect(await env.absolutePath("nested", ctx)).toEqual({
    ok: true,
    value: join(env.cwd, "nested"),
  });
  expect(await env.joinPath([env.cwd, "nested", "a"], ctx)).toEqual({
    ok: true,
    value: join(env.cwd, "nested", "a"),
  });
  await env.writeFile("nested/a", "a", ctx);
  await env.appendFile("nested/a", "bc", ctx);
  expect((await env.truncateFile("nested/a", 2, ctx)).ok).toBe(true);
  expect((await env.flushFile("nested/a", ctx)).ok).toBe(true);
  expect((await env.renameFile("nested/a", "nested/b", ctx)).ok).toBe(true);
  expect(await env.readTextFile("nested/b", ctx)).toEqual({ ok: true, value: "ab" });
  const info = await env.fileInfo("nested/b", ctx);
  expect(info.ok && info.value.size).toBe(2);
  const entries = await env.listDir("nested", ctx);
  expect(entries.ok && entries.value.map((entry) => entry.name)).toEqual(["b"]);
  expect(await env.canonicalPath("nested/b", ctx)).toEqual({
    ok: true,
    value: join(env.cwd, "nested", "b"),
  });
  const dir = await env.createTempDir("execution-test-", ctx);
  expect(dir.ok).toBe(true);
  if (dir.ok) await env.remove(dir.value, { recursive: true }, ctx);
  const file = await env.createTempFile({ prefix: "execution-test-", suffix: ".txt" }, ctx);
  expect(file.ok).toBe(true);
  if (file.ok) {
    expect(await env.exists(file.value, ctx)).toEqual({ ok: true, value: true });
    await env.remove(file.value, undefined, ctx);
  }
  expect((await env.remove("nested", { recursive: true }, ctx)).ok).toBe(true);
});

test("host shutdown drains a running command before closing HTTP", async () => {
  const env = await start();
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = env.exec("echo started; sleep 100", { onOutput: () => ready() }, context());
  await started;
  if (!child) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const outcome = await result;
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe("aborted");
  await exited;
});

test("line reads reject oversized single lines without buffering the file", async () => {
  const env = await start();
  const ctx = context();
  await env.exec("head -c 4194304 /dev/zero | tr '\\000' x > huge-line", undefined, ctx);
  const opened = await env.openTextLineReader("huge-line", ctx);
  expect(opened.ok).toBe(true);
  if (opened.ok) {
    const line = await opened.value.readLine(ctx);
    expect(line.ok).toBe(false);
    if (!line.ok) expect(line.error.code).toBe("invalid");
    await opened.value.close(ctx);
  }
});

test("abort kills command process group and stale incarnation refuses effects", async () => {
  const env = await start();
  const abort = new AbortController();
  let commandPid = "";
  const result = await env.exec(
    "sleep 100 & echo $!; wait; echo bad > late-effect",
    {
      onOutput: (text) => {
        commandPid += text;
        abort.abort();
      },
    },
    context(abort.signal),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("aborted");
  expect(await env.exists("late-effect", context())).toEqual({ ok: true, value: false });
  expect(commandPid.trim()).toMatch(/^\d+$/);
  let processState = "";
  await env.exec(
    `ps -o stat= -p ${commandPid.trim()}`,
    {
      onOutput: (text) => {
        processState += text;
      },
    },
    context(),
  );
  expect(processState.trim() === "" || processState.trim().startsWith("Z")).toBe(true);
  const stale = new RemoteExecutionEnv({
    baseUrl: env.baseUrl,
    token: "test-token",
    incarnation: "6",
    cwd: directory!,
  });
  expect((await stale.writeFile("stale-effect", "bad", context())).ok).toBe(false);
  expect(await env.exists("stale-effect", context())).toEqual({ ok: true, value: false });
  const captureId = "00000000-0000-4000-8000-000000000000";
  const rejected = await stale.installOwnerSkills(captureId, { skills: [] }, context());
  expect(rejected._unsafeUnwrapErr()).toEqual({
    type: "execution_transport_error",
    code: "unavailable",
    message: "stale execution incarnation",
  });
  expect(await env.exists(ownerSkillCapturePath(captureId), context())).toEqual({
    ok: true,
    value: false,
  });
  expect((await env.installOwnerSkills(captureId, { skills: [] }, context())).isOk()).toBe(true);
});
