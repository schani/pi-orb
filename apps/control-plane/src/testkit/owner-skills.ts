import { ApplicationFailure, type SimulationTask } from "determined";
import { ok, type Result, ResultAsync } from "neverthrow";
import {
  applyOwnerSkillCommand,
  ownerSkillError as failure,
  type OwnerSkillCommand,
  type OwnerSkillError,
  type OwnerSkillRecord,
  type OwnerSkillStore,
} from "../domain/owner-skills.ts";

/**
 * Simulation-backed owner skill store. Each command commits synchronously
 * between two scheduling points, modelling the PostgreSQL per-user lock.
 */
export class FakeOwnerSkillStore implements OwnerSkillStore {
  /** Every committed state, per user, in commit order. */
  readonly commits = new Map<string, OwnerSkillRecord[][]>();

  /** Commits a starting state directly, outside any simulated schedule. */
  seed(userId: string, skills: ReadonlyArray<{ name: string; content: string }>): void {
    const updatedAt = new Date(0).toISOString();
    const state = skills
      .map((skill) => ({ ...skill, updatedAt }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    this.commits.set(userId, [...(this.commits.get(userId) ?? []), state]);
  }

  list(task: SimulationTask, userId: string) {
    return this.operation(task, "list", userId, (current) => ok(current));
  }
  apply(task: SimulationTask, userId: string, command: OwnerSkillCommand) {
    return this.operation(task, command.kind, userId, (current) =>
      applyOwnerSkillCommand(current, command, new Date(task.wallNow()).toISOString()),
    );
  }

  private operation(
    task: SimulationTask,
    name: string,
    userId: string,
    apply: (current: OwnerSkillRecord[]) => Result<OwnerSkillRecord[], OwnerSkillError>,
  ): ResultAsync<OwnerSkillRecord[], OwnerSkillError> {
    return ResultAsync.fromPromise(
      (async () => {
        await task.sleep(1 + task.random("owner skills latency") * 5, name);
        await task.failpoint(`owner-skills.${name}.before`);
        const next = apply([...(this.commits.get(userId)?.at(-1) ?? [])]);
        if (next.isOk() && name !== "list")
          this.commits.set(userId, [...(this.commits.get(userId) ?? []), next.value]);
        await task.sleep(1 + task.random("owner skills reply latency") * 5, `${name} reply`);
        await task.failpoint(`owner-skills.${name}.after`);
        return next.map((items) => [...items]);
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure("unavailable", "Owner skills unavailable")
          : task.abortSimulation(error),
    ).andThen((result) => result);
  }
}
