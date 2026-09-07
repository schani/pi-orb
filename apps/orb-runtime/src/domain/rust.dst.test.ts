import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../../../control-plane/src/testkit/sim.ts";
import { ensurePersistentRustToolchain, type RustToolchainError } from "./rust.ts";

const failure = (message: string): RustToolchainError => ({
  type: "rust_toolchain_error",
  message,
});

describe("persistent Rust toolchain retry scheduling", () => {
  it("recovers within the bounded retry window under varied schedules", async () => {
    await runDst({ name: "rust-toolchain-transient-recovery", iterations: 30 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "bootstrap",
          f: async (task) => {
            const startedAt = task.monotonicNow();
            let calls = 0;
            const events: unknown[] = [];
            const installed = await ensurePersistentRustToolchain(
              "/orb/home",
              {},
              () => {
                calls += 1;
                if (calls === 1) return errAsync(failure("no active toolchain"));
                if (calls < 4) {
                  return errAsync(failure("dns error: Temporary failure in name resolution"));
                }
                return okAsync("stable");
              },
              {
                now: () => task.monotonicNow(),
                sleep: (ms) => task.sleep(ms, "rust toolchain retry backoff"),
                report: async (event) => {
                  events.push(event);
                },
              },
            );

            expect(installed.isOk()).toBe(true);
            expect(calls).toBe(4);
            expect(events).toEqual([
              { type: "retry", attempt: 2, delayMs: 5_000, errorClass: "dns" },
              { type: "retry", attempt: 3, delayMs: 15_000, errorClass: "dns" },
              { type: "recovered", attempt: 3 },
            ]);
            expect(task.monotonicNow() - startedAt).toBeGreaterThanOrEqual(20_000);
            expect(task.monotonicNow() - startedAt).toBeLessThan(180_000);
          },
        },
        {
          name: "unrelated boot work",
          f: async (task) => {
            await task.sleep(1 + task.random("unrelated boot delay") * 25_000, "boot work");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("allows a slow healthy download within the total setup deadline", async () => {
    await runDst({ name: "rust-toolchain-deadline", iterations: 30 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "bootstrap",
          f: async (task) => {
            const startedAt = task.monotonicNow();
            const timeouts: number[] = [];
            let calls = 0;
            const installed = await ensurePersistentRustToolchain(
              "/orb/home",
              {},
              (_args, _environment, timeoutMs) => {
                calls += 1;
                timeouts.push(timeoutMs);
                if (calls === 1) return errAsync(failure("no active toolchain"));
                return ResultAsync.fromSafePromise(
                  task.sleep(120_000, "healthy Rust download"),
                ).map(() => "stable");
              },
              {
                now: () => task.monotonicNow(),
                sleep: (ms) => task.sleep(ms, "rust toolchain retry backoff"),
                report: async () => undefined,
              },
            );

            expect(installed.isOk()).toBe(true);
            expect(timeouts).toHaveLength(2);
            expect(timeouts[0]).toBe(5_000);
            expect(timeouts[1]).toBe(180_000);
            expect(task.monotonicNow() - startedAt).toBeLessThanOrEqual(180_000);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("does not start another command after reporting consumes the deadline", async () => {
    await runDst({ name: "rust-toolchain-report-deadline", iterations: 30 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "bootstrap",
          f: async (task) => {
            let calls = 0;
            const installed = await ensurePersistentRustToolchain(
              "/orb/home",
              {},
              () => {
                calls += 1;
                return errAsync(
                  failure(
                    calls === 1
                      ? "no active toolchain"
                      : "dns error: Temporary failure in name resolution",
                  ),
                );
              },
              {
                now: () => task.monotonicNow(),
                sleep: (ms) => task.sleep(ms, "rust toolchain retry backoff"),
                report: (_event, timeoutMs) => task.sleep(timeoutMs, "slow diagnostic sink"),
              },
            );
            expect(installed.isErr()).toBe(true);
            expect(calls).toBe(2);
            expect(task.monotonicNow()).toBe(180_000);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
