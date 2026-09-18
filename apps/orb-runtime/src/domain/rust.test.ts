import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configurePersistentRust } from "./rust.ts";

describe("persistent Rust environment", () => {
  it("keeps rustup and Cargo state in the orb home without selecting a toolchain", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    configurePersistentRust("/orb/home", environment);

    expect(environment.RUSTUP_HOME).toBe(join("/orb/home", ".rustup"));
    expect(environment.CARGO_HOME).toBe(join("/orb/home", ".cargo"));
    expect(environment.PATH).toBe(`${join("/orb/home", ".cargo/bin")}:/usr/bin`);
  });
});
