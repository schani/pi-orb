import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

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
    `import { ok } from "neverthrow";
export class ClaudeOrbAgent {
  closed = false;
  health = { status: "ready" };
  waiting;
  waitForStream() { process.send({ barrier: "iterator-eof" }); return Promise.resolve(); }
  closeExtensions() {
    this.closed = true;
    return new Promise(resolve => { this.waiting = resolve; });
  }
  replicationSnapshot() { return ok({ closeRequested: this.closed, session: { id: "00000000-0000-4000-8000-000000000029" }, records: [{ id: "00000000-0000-4000-8000-000000000029", type: "message", content: "PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT" }] }); }
  getHealth() { return this.health; }
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
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  child.on("message", (value) => {
    messages.push(value as Record<string, unknown>);
    for (const wake of waiters) wake();
  });
  const waitFor = async (predicate: (value: Record<string, unknown>) => boolean) => {
    while (!messages.some(predicate))
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
      });
    return messages.find(predicate);
  };
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
    const ended = once(child, "close");
    child.kill("SIGKILL");
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});
