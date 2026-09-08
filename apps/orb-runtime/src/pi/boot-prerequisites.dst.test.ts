import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { settleBootPrerequisites } from "./boot-prerequisites.ts";

describe("concurrent boot prerequisite scheduling", () => {
  it("settles every outcome independently of completion order", async () => {
    await runDst({ name: "boot-prerequisites", iterations: 30 }, async (sim) => {
      for (const [rustFails, checkoutFails] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ] as const) {
        const result = await sim.runTasks([
          {
            name: `boot-${rustFails}-${checkoutFails}`,
            f: async (task) => {
              const started: string[] = [];
              const completed: string[] = [];
              const settled = await settleBootPrerequisites(
                () => {
                  started.push("rust");
                  return task.sleep(task.random("rust delay") * 1_000, "Rust setup").then(() => {
                    completed.push("rust");
                    return rustFails ? err<string, string>("rust failed") : ok("stable");
                  });
                },
                () => {
                  started.push("checkout");
                  return task
                    .sleep(task.random("checkout delay") * 1_000, "repository checkout")
                    .then(() => {
                      completed.push("checkout");
                      return checkoutFails ? err<string, string>("clone failed") : ok("commit");
                    });
                },
              );

              expect(started).toEqual(["rust", "checkout"]);
              expect(completed.sort()).toEqual(["checkout", "rust"]);
              if (rustFails) expect(settled._unsafeUnwrapErr()).toBe("rust failed");
              else if (checkoutFails) expect(settled._unsafeUnwrapErr()).toBe("clone failed");
              else expect(settled._unsafeUnwrap()).toEqual(["stable", "commit"]);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      }
    });
  });
});
