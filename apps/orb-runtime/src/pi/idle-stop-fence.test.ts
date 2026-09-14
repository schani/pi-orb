import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { err, okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "./agent.ts";
import { FileIdleStopFence, type IdleStopFence } from "./idle-stop-fence.ts";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-idle-fence-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("atomically replaces a private lifetime fence and returns typed read/write errors", () => {
  const root = directory();
  const fence = new FileIdleStopFence(root);
  expect(fence.read()._unsafeUnwrap()).toBeNull();
  fence.write("host:first")._unsafeUnwrap();
  fence.write("host:second")._unsafeUnwrap();
  expect(new FileIdleStopFence(root).read()._unsafeUnwrap()).toBe("host:second");
  expect(readdirSync(root)).toEqual([".idle-stop-fence"]);
  expect(statSync(join(root, ".idle-stop-fence")).mode & 0o777).toBe(0o600);
  writeFileSync(join(root, ".idle-stop-fence"), "");
  expect(fence.read().isErr()).toBe(true);
  expect(new FileIdleStopFence(join(root, "missing")).write("host:first").isErr()).toBe(true);
});

it.each([false, true])(
  "keeps admission closed when the fence write fails (committed=%s)",
  (committed) => {
    const root = directory();
    const disk = new FileIdleStopFence(root);
    const faulty: IdleStopFence = {
      read: () => disk.read(),
      write: (lifetime) => {
        if (committed) disk.write(lifetime)._unsafeUnwrap();
        return err({ type: "idle_stop_fence_error", message: "injected fence write failure" });
      },
    };
    const attach = (idleStopFence: IdleStopFence) => {
      const agent = new PiOrbAgent({
        orbId: "fence",
        repositoryUrl: "https://example.com/repo",
        workDir: root,
        skillsDir: null,
        broker: null,
        executionId: "host",
        idleStopFence,
      });
      agent.attachSession(
        { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
        SessionManager.inMemory(root),
        { summarize: () => okAsync("") },
      );
      return agent;
    };
    const first = attach(faulty);
    expect(first.prepareIdleStop().isErr()).toBe(true);
    expect(first.getHealth()).toMatchObject({ status: "failed" });
    expect(first.gateView().acceptingWork).toBe(false);
    expect(first.admitSubagent("forbidden").isErr()).toBe(true);
    expect(attach(disk).gateView().acceptingWork).toBe(!committed);
  },
);

it("preserves preparation across restart even before Pi has flushed its first session", () => {
  const root = directory();
  const pi = { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession;
  const attach = (executionId: string) => {
    const agent = new PiOrbAgent({
      orbId: "empty",
      repositoryUrl: "https://example.com/repo",
      workDir: root,
      skillsDir: null,
      broker: null,
      executionId,
    });
    const manager = SessionManager.create(root, root);
    agent.attachSession(pi, manager, { summarize: () => okAsync("") });
    return { agent, manager };
  };
  const first = attach("first-execution");
  expect(first.agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
  expect(existsSync(first.manager.getSessionFile() as string)).toBe(false);
  expect(attach("first-execution").agent.gateView().acceptingWork).toBe(false);
  expect(attach("next-execution").agent.gateView().acceptingWork).toBe(true);
});
