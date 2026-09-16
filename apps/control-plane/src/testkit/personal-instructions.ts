import type { PersonalInstructions } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import type { PersonalInstructionsStore } from "../domain/personal-instructions.ts";

export class FakePersonalInstructionsStore implements PersonalInstructionsStore {
  readonly snapshots = new Map<string, PersonalInstructions>();
  readonly commits: PersonalInstructions[] = [];
  readonly commitsByUser = new Map<string, PersonalInstructions[]>();
  private readonly users = new Set<string>();

  constructor(userIds: Iterable<string> = []) {
    for (const userId of userIds) this.seedUser(userId);
  }

  seedUser(userId: string): void {
    this.users.add(userId);
  }

  get snapshot(): PersonalInstructions {
    return (
      this.snapshots.get("00000000-0000-4000-8000-000000000001") ?? {
        content: "",
        revision: 0,
      }
    );
  }
  set snapshot(value: PersonalInstructions) {
    this.snapshots.set("00000000-0000-4000-8000-000000000001", value);
  }

  read(task: SimulationTask, userId: string) {
    if (!this.users.has(userId)) return errAsync(this.unknownUser());
    return this.operation(task, "read", () => ({
      ...(this.snapshots.get(userId) ?? { content: "", revision: 0 }),
    }));
  }
  replace(task: SimulationTask, userId: string, content: string) {
    if (!this.users.has(userId)) return errAsync(this.unknownUser());
    return this.operation(task, "write", () => {
      const previous = this.snapshots.get(userId) ?? { content: "", revision: 0 };
      const snapshot = { content, revision: previous.revision + 1 };
      this.snapshots.set(userId, snapshot);
      this.commits.push(snapshot);
      const commits = this.commitsByUser.get(userId) ?? [];
      commits.push(snapshot);
      this.commitsByUser.set(userId, commits);
      return { ...snapshot };
    });
  }
  private unknownUser() {
    return {
      type: "personal_instructions_error" as const,
      code: "internal" as const,
      message: "Personal instructions storage is inconsistent",
    };
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
