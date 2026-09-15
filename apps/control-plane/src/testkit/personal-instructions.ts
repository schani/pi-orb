import type { PersonalInstructions } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { PersonalInstructionsStore } from "../domain/personal-instructions.ts";

export class FakePersonalInstructionsStore implements PersonalInstructionsStore {
  snapshot: PersonalInstructions = { content: "", revision: 0 };
  readonly commits: PersonalInstructions[] = [];

  read(task: SimulationTask) {
    return this.operation(task, "read", () => ({ ...this.snapshot }));
  }
  replace(task: SimulationTask, content: string) {
    return this.operation(task, "write", () => {
      this.snapshot = { content, revision: this.snapshot.revision + 1 };
      this.commits.push(this.snapshot);
      return { ...this.snapshot };
    });
  }
  private operation(task: SimulationTask, name: string, commit: () => PersonalInstructions) {
    return ResultAsync.fromPromise(
      (async () => {
        await task.sleep(1 + task.random("personal instructions latency") * 5, name);
        await task.failpoint(`personal-instructions.${name}.before`);
        const result = commit();
        await task.sleep(
          1 + task.random("personal instructions reply latency") * 5,
          `${name} reply`,
        );
        await task.failpoint(`personal-instructions.${name}.after`);
        return result;
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? {
              type: "personal_instructions_error" as const,
              code: "unavailable" as const,
              message: "Personal instructions unavailable",
            }
          : task.abortSimulation(error),
    );
  }
}
