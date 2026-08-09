import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { ensurePersistentRustToolchain, type RustToolchainError } from "./rust.ts";

const failure = (message: string): RustToolchainError => ({
  type: "rust_toolchain_error",
  message,
});

describe("persistent Rust toolchain", () => {
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

  it("returns a typed failure when stable cannot be installed", async () => {
    const result = await ensurePersistentRustToolchain("/orb/home", {}, () =>
      errAsync(failure("download failed")),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toEqual(failure("download failed"));
  });
});
