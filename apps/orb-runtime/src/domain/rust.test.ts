import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  classifyRustupFailure,
  ensurePersistentRustToolchain,
  type RustToolchainError,
  rustupExecFailure,
} from "./rust.ts";

const failure = (message: string): RustToolchainError => ({
  type: "rust_toolchain_error",
  message,
});

describe("persistent Rust toolchain", () => {
  it("classifies an exec timeout as retryable without relying on stderr text", () => {
    const timeout = rustupExecFailure(
      Object.assign(new Error("killed"), { killed: true }),
      "info: syncing channel updates",
    );
    expect(classifyRustupFailure(timeout)).toEqual({
      type: "rust_toolchain_error",
      message: "info: syncing channel updates",
      retryable: true,
    });
  });
  it("uses an existing default without contacting the stable channel", async () => {
    const calls: string[][] = [];
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    const result = await ensurePersistentRustToolchain("/orb/home", environment, (args) => {
      calls.push([...args]);
      return okAsync("stable-x86_64-unknown-linux-gnu (default)");
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([["default"]]);
    expect(environment.RUSTUP_HOME).toBe(join("/orb/home", ".rustup"));
    expect(environment.CARGO_HOME).toBe(join("/orb/home", ".cargo"));
    expect(environment.PATH).toBe(`${join("/orb/home", ".cargo/bin")}:/usr/bin`);
  });

  it("installs stable once when a fresh home has no active toolchain", async () => {
    const calls: string[][] = [];

    const result = await ensurePersistentRustToolchain(
      "/orb/home",
      { PATH: "/usr/bin" },
      (args) => {
        calls.push([...args]);
        return calls.length === 1 ? errAsync(failure("no active toolchain")) : okAsync("stable");
      },
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([["default"], ["default", "stable"]]);
  });

  it("recovers from transient install failures with bounded delays", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    const events: unknown[] = [];
    let now = 0;
    const result = await ensurePersistentRustToolchain(
      "/orb/home",
      {},
      (args) => {
        calls.push([...args]);
        if (calls.length === 1) return errAsync(failure("no active toolchain"));
        if (calls.length < 4)
          return errAsync(failure("dns error: Temporary failure in name resolution"));
        return okAsync("stable");
      },
      {
        now: () => now,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        report: async (event) => {
          events.push(event);
        },
      },
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([
      ["default"],
      ["default", "stable"],
      ["default", "stable"],
      ["default", "stable"],
    ]);
    expect(delays).toEqual([5_000, 15_000]);
    expect(events).toEqual([
      { type: "retry", attempt: 2, delayMs: 5_000, errorClass: "dns" },
      { type: "retry", attempt: 3, delayMs: 15_000, errorClass: "dns" },
      { type: "recovered", attempt: 3 },
    ]);
  });

  it("bounds persistent transient failures", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await ensurePersistentRustToolchain(
      "/orb/home",
      {},
      () => {
        calls += 1;
        return errAsync(failure("failed to lookup address information"));
      },
      {
        now: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
        report: async () => undefined,
      },
    );

    expect(result.isErr()).toBe(true);
    expect(calls).toBe(4);
    expect(delays).toEqual([5_000, 15_000]);
  });

  it("does not retry permanent install failures", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await ensurePersistentRustToolchain(
      "/orb/home",
      {},
      () => {
        calls += 1;
        return errAsync(failure("checksum failed"));
      },
      {
        now: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
        report: async () => undefined,
      },
    );

    expect(result.isErr()).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([]);
  });

  it.each([
    ["http request returned an unsuccessful status code: 429", "http_429"],
    ["http request returned an unsuccessful status code: 503", "http_5xx"],
  ])("classifies rustup HTTP failure %s", async (message, errorClass) => {
    const events: unknown[] = [];
    let calls = 0;
    const result = await ensurePersistentRustToolchain(
      "/orb/home",
      {},
      () => {
        calls += 1;
        return calls < 3
          ? errAsync(failure(calls === 1 ? "no active toolchain" : message))
          : okAsync("stable");
      },
      {
        now: () => 0,
        sleep: async () => undefined,
        report: async (event) => {
          events.push(event);
        },
      },
    );
    expect(result.isOk()).toBe(true);
    expect(events[0]).toEqual({ type: "retry", attempt: 2, delayMs: 5_000, errorClass });
  });

  it("returns a typed failure when stable cannot be installed", async () => {
    const result = await ensurePersistentRustToolchain("/orb/home", {}, () =>
      errAsync(failure("download failed")),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toEqual(failure("download failed"));
  });
});
