import type { ExecFileException } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, ResultAsync } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  onRustStart: undefined as undefined | ((resolve: () => void) => void),
  onGitStart: undefined as
    | undefined
    | ((
        args: string[],
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => void),
}));

vi.mock("../domain/rust.ts", () => ({
  ensurePersistentRustToolchain: () =>
    ResultAsync.fromSafePromise(
      new Promise<void>((resolve) => {
        controls.onRustStart?.(resolve);
      }),
    ),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      controls.onGitStart?.(args, callback);
      return {} as ReturnType<typeof original.execFile>;
    },
  };
});

import type { HookSpawner } from "../hooks/ports.ts";
import { PiOrbAgent } from "./agent.ts";

const workDirs: string[] = [];
const originalEnvironment = {
  HOME: process.env["HOME"],
  RUSTUP_HOME: process.env["RUSTUP_HOME"],
  CARGO_HOME: process.env["CARGO_HOME"],
  PATH: process.env["PATH"],
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(() => {
  controls.onRustStart = undefined;
  controls.onGitStart = undefined;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const workDir of workDirs.splice(0)) rmSync(workDir, { recursive: true, force: true });
});

describe("agent boot prerequisites", () => {
  it("starts checkout while Rust is blocked and waits for both before setup", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-orb-boot-"));
    workDirs.push(workDir);
    const rustStarted = deferred<() => void>();
    const cloneStarted =
      deferred<(error: ExecFileException | null, stdout: string, stderr: string) => void>();
    const revParseStarted =
      deferred<(error: ExecFileException | null, stdout: string, stderr: string) => void>();
    controls.onRustStart = rustStarted.resolve;
    controls.onGitStart = (args, callback) => {
      if (args[0] === "clone") cloneStarted.resolve(callback);
      else revParseStarted.resolve(callback);
    };
    let setupCalls = 0;
    const hookSpawner: HookSpawner = {
      spawn: () => {
        setupCalls += 1;
        return ok({
          exited: Promise.resolve({ code: 0, signal: null }),
          killGroup: () => undefined,
          tail: () => [],
        });
      },
    };
    const agent = new PiOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://github.com/example/repo.git",
      workDir,
      broker: null,
      skillsDir: null,
      hookSpawner,
    });

    const boot = agent.boot();
    const [resolveRust, resolveClone] = await Promise.all([
      rustStarted.promise,
      cloneStarted.promise,
    ]);
    expect(setupCalls).toBe(0);

    mkdirSync(join(workDir, ".clone-tmp", ".agents"), { recursive: true });
    const setupPath = join(workDir, ".clone-tmp", ".agents", "setup");
    writeFileSync(setupPath, "#!/bin/sh\n");
    chmodSync(setupPath, 0o755);
    resolveClone(null, "", "");
    const resolveRevParse = await revParseStarted.promise;
    await Promise.resolve();
    expect(setupCalls).toBe(0);
    expect(agent.getHealth()).toMatchObject({ status: "initializing", phase: "cloning" });

    resolveRevParse(null, "abc123\n", "");
    await Promise.resolve();
    expect(setupCalls).toBe(0);
    resolveRust();
    await boot;
    expect(setupCalls).toBe(1);
    expect(agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "project_secrets_unavailable" },
    });
  });
});
