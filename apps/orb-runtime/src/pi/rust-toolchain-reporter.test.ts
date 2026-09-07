import { describe, expect, it } from "vitest";
import { reportRustToolchainEdge } from "./rust-toolchain-reporter.ts";

describe("Rust toolchain boot reporter", () => {
  it("writes the bounded native diagnostic contract and keeps a stdout fallback", async () => {
    const calls: unknown[][] = [];
    const logs: string[] = [];
    await reportRustToolchainEdge(
      { type: "retry", attempt: 2, delayMs: 5_000, errorClass: "dns" },
      12_345,
      (args, timeoutMs, done) => {
        calls.push([[...args], timeoutMs]);
        done();
      },
      (message) => logs.push(message),
    );

    expect(calls).toEqual([
      [
        [
          "runtime",
          "event",
          "rust_toolchain_retry",
          "",
          '{"attempt":2,"delayMs":5000,"errorClass":"dns"}',
        ],
        12_345,
      ],
    ]);
    expect(logs).toEqual([
      'rust toolchain: {"type":"retry","attempt":2,"delayMs":5000,"errorClass":"dns"}',
    ]);
  });

  it("reports recovery without transient failure details", async () => {
    const calls: string[][] = [];
    await reportRustToolchainEdge(
      { type: "recovered", attempt: 3 },
      1_000,
      (args, _timeoutMs, done) => {
        calls.push([...args]);
        done();
      },
      () => undefined,
    );
    expect(calls[0]).toEqual(["runtime", "event", "rust_toolchain_recovered", "", '{"attempt":3}']);
  });
});
