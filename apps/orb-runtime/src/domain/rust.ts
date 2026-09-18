import { join } from "node:path";

/** Points rustup and Cargo at durable orb state without selecting a toolchain. */
export function configurePersistentRust(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const cargoHome = join(home, ".cargo");
  environment.RUSTUP_HOME = join(home, ".rustup");
  environment.CARGO_HOME = cargoHome;
  environment.PATH = `${join(cargoHome, "bin")}:${environment.PATH ?? ""}`;
}
