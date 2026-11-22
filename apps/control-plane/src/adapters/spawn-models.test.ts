import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { createOrbModelCatalog } from "./spawn-models.ts";

const { query } = vi.hoisted(() => ({
  query:
    vi.fn<
      (options: { options: Options & { abortController: AbortController; cwd: string } }) => {
        supportedModels: () => Promise<never>;
        close: () => void;
        return: () => Promise<void>;
      }
    >(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", { spy: true });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const task = new NoSimulationTask("offline model catalog", false);
const list = createOrbModelCatalog(
  () => {
    throw new Error("Claude does not use the Codex broker");
  },
  { grant: () => okAsync({ token: "PRIVATE_TOKEN", generation: 1 }) },
);

afterEach(() => {
  vi.useRealTimers();
  query.mockReset();
  vi.mocked(spawn).mockReset();
  vi.mocked(rm).mockClear();
});

it.each(["probe_failed", "probe_timeout"] as const)(
  "returns a content-free %s from the Claude catalog probe",
  async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = deferred();
    const close = vi.fn();
    query.mockImplementation(({ options: { abortController } }) => ({
      supportedModels: () => {
        started.resolve();
        const sdkError = new Error("PRIVATE_SDK_DIAGNOSTIC");
        return reason === "probe_failed"
          ? Promise.reject(sdkError)
          : new Promise((_, reject) => {
              abortController.signal.addEventListener("abort", () => reject(sdkError), {
                once: true,
              });
            });
      },
      close,
      return: async () => close(),
    }));
    const result = list(task, "owner", "claude");
    await started.promise;
    if (reason === "probe_timeout") await vi.advanceTimersByTimeAsync(10_000);
    expect((await result)._unsafeUnwrapErr()).toEqual({ type: "model_catalog_error", reason });
    expect(close).toHaveBeenCalledOnce();
  },
);

function mockClaudeChild() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const closing = deferred<string>();
  const awaitingShutdown = deferred();
  const sdkClosed = deferred();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  query.mockImplementation(({ options: { cwd, spawnClaudeCodeProcess, abortController } }) => {
    spawnClaudeCodeProcess?.({
      command: "synthetic-claude",
      args: [],
      cwd,
      env: {},
      signal: abortController.signal,
    });
    const close = () => closing.resolve(cwd);
    return {
      supportedModels: () => Promise.reject(new Error("PRIVATE_SDK_DIAGNOSTIC")),
      close,
      return: async () => {
        close();
        awaitingShutdown.resolve();
        await sdkClosed.promise;
      },
    };
  });
  return {
    child,
    closing: closing.promise,
    awaitingShutdown: awaitingShutdown.promise,
    finishSdkCleanup: () => sdkClosed.resolve(),
    exit: () => {
      child.emit("exit", 0, null);
      sdkClosed.resolve();
    },
  };
}

it("removes the config after the CLI's final writer and exit, even when the probe failed", async () => {
  const cli = mockClaudeChild();
  const result = list(task, "owner", "claude");
  const directory = await cli.closing;
  try {
    // Release the writer when the adapter awaits shutdown or returns too early.
    // If it returns early the writer deterministically recreates the directory.
    await Promise.race([cli.awaitingShutdown, result]);
    const existedBeforeExit = existsSync(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "late-config"), "synthetic");
    cli.exit();

    expect((await result)._unsafeUnwrapErr()).toEqual({
      type: "model_catalog_error",
      reason: "probe_failed",
    });
    expect(existsSync(directory)).toBe(false);
    expect(existedBeforeExit).toBe(true);
    expect(cli.child.kill).not.toHaveBeenCalled();
  } finally {
    cli.exit();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["exit after kill", "exit after deadline"] as const)(
  "bounds CLI cleanup when SDK cleanup finishes first: %s",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cli = mockClaudeChild();
    const result = list(task, "owner", "claude");
    const directory = await cli.closing;
    try {
      await cli.awaitingShutdown;
      cli.finishSdkCleanup();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(cli.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      // Delivery of SIGKILL is not confirmation of exit.
      expect(rm).not.toHaveBeenCalled();
      if (outcome === "exit after kill") {
        cli.exit();
        expect((await result)._unsafeUnwrapErr().reason).toBe("probe_failed");
      } else {
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await result)._unsafeUnwrapErr()).toEqual({
          type: "model_catalog_error",
          reason: "cleanup_failed",
        });
        expect(rm).not.toHaveBeenCalled();
        cli.exit();
        await Promise.resolve();
        expect(rm).toHaveBeenCalledExactlyOnceWith(directory, { recursive: true, force: true });
        await vi.mocked(rm).mock.results[0]?.value;
      }
      expect(existsSync(directory)).toBe(false);
    } finally {
      cli.exit();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
