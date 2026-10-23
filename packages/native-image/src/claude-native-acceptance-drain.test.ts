import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function observeWorker(child: ChildProcess) {
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  let failure: string | undefined;
  let closed = false;
  let stderrBytes = 0;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const wake = () => {
    for (const waiter of waiters) waiter();
  };
  const onMessage = (value: unknown) => {
    messages.push(value as Record<string, unknown>);
    wake();
  };
  const onError = () => {
    failure = "worker_error";
    wake();
  };
  const onStderr = (chunk: Buffer) => {
    stderrBytes = Math.min(65536, stderrBytes + chunk.length);
  };
  const onClose = (code: number | null, signal: string | null) => {
    closed = true;
    failure ??= `worker_closed code=${code} signal=${signal} stderrBytes=${stderrBytes}`;
    wake();
    finish();
  };
  child.on("message", onMessage);
  child.on("error", onError);
  child.on("close", onClose);
  child.stderr?.on("data", onStderr);
  return {
    messages,
    async waitFor(predicate: (value: Record<string, unknown>) => boolean) {
      while (!messages.some(predicate)) {
        if (failure) throw new Error(failure);
        await new Promise<void>((resolve) => {
          const waiter = () => {
            waiters.delete(waiter);
            resolve();
          };
          waiters.add(waiter);
        });
      }
      return messages.find(predicate);
    },
    async close() {
      if (!closed) child.kill("SIGKILL");
      await completion;
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
      child.stderr?.off("data", onStderr);
    },
  };
}

it("reports a post-EOF drain failure instead of subscribing to an impossible idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-drain-boundary-"));
  const repository = new URL("../../../", import.meta.url).pathname;
  await mkdir(join(root, "apps/orb-runtime/src/claude"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await mkdir(join(root, "claude/config"), { recursive: true });
  await writeFile(
    join(root, "claude/config/00000000-0000-4000-8000-000000000029.jsonl"),
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000029",
      content: "PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT",
    }) + "\n",
  );
  await writeFile(
    join(root, "apps/orb-runtime/src/claude/agent.ts"),
    `import { ok, err } from "neverthrow";
export class ClaudeOrbAgent {
  closed = false;
  health = { status: "ready" };
  waiting;
  waitForStream() { process.send({ barrier: "iterator-eof" }); return Promise.resolve(); }
  closeExtensions() {
    this.closed = true;
    return new Promise(resolve => { this.waiting = resolve; });
  }
  replicationSnapshot() { if (this.health.status === "failed") return err({ code: "history_unavailable" }); return ok({ closeRequested: this.closed, session: { id: "00000000-0000-4000-8000-000000000029" }, records: [{ id: "00000000-0000-4000-8000-000000000029", type: "message", content: "PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT" }] }); }
  getHealth() { return this.health; }
  sessionId() { return "00000000-0000-4000-8000-000000000029"; }
  gateView() { return { activity: "busy" }; }
  subscribe() { return () => {}; }
  deliverInboxMessage() {
    this.health = { status: "failed", error: { code: "claude_stream_identity_gap", message: "PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT" } };
    this.waiting?.();
    return Promise.resolve(ok({}));
  }
}
`,
  );
  const child = fork("infra/native-vm/claude-worker.mjs", [root, root, "unused", "unused", "1"], {
    env: { PATH: process.env["PATH"] },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const { messages, waitFor, close } = observeWorker(child);
  try {
    await waitFor((reply) => reply["ready"] === true);
    child.send({ id: 1, method: "idle" });
    await waitFor((reply) => reply["barrier"] === "iterator-eof");
    child.send({ id: 2, method: "snapshot" });
    const snapshot = await waitFor((reply) => reply["id"] === 2);
    expect(snapshot).toMatchObject({ result: { snapshot: { closeRequested: true } } });
    child.send({ id: 3, method: "deliver", messageId: "release-drain", content: "synthetic" });
    expect(await waitFor((reply) => reply["id"] === 1)).toEqual({
      id: 1,
      error: "synthetic_runtime_idle_claude_stream_identity_gap",
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualificationEvidence: expect.objectContaining({
            health: { status: "failed", code: "claude_stream_identity_gap" },
            records: [
              expect.objectContaining({
                uuid: "00000000-0000-4000-8000-000000000029",
                type: "message",
              }),
            ],
            nativeRows: expect.arrayContaining([
              expect.objectContaining({ uuid: "00000000-0000-4000-8000-000000000029" }),
            ]),
          }),
        }),
      ]),
    );
    const traces = messages.filter((reply) => reply["qualificationEvidence"]);
    expect(JSON.stringify(traces)).not.toContain("PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT");
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects an IPC wait causally when the worker exits before readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-drain-exit-"));
  const script = join(root, "early.mjs");
  await writeFile(script, "process.stderr.write('PRIVATE_PROVIDER_TOKEN'); process.exit(23);");
  const child = fork(script, [], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const worker = observeWorker(child);
  try {
    await expect(worker.waitFor((reply) => reply["ready"] === true)).rejects.toThrow(
      "worker_closed code=23",
    );
  } finally {
    await worker.close();
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects child errors without exposing raw diagnostics and joins an already closed worker", async () => {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill(this: EventEmitter) {
      queueMicrotask(() => this.emit("close", null, "SIGKILL"));
      return true;
    },
  });
  const worker = observeWorker(child as unknown as ChildProcess);
  const waiting = worker.waitFor(() => false);
  child.emit("error", new Error("PRIVATE_PROVIDER_TOKEN"));
  await expect(waiting).rejects.toThrow(/^worker_error$/);
  child.emit("close", 23, null);
  await worker.close();
  expect(child.listenerCount("error")).toBe(0);
  expect(child.listenerCount("message")).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
});
