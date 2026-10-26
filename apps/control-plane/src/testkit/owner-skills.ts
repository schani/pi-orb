import { OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { OwnerSkillError, OwnerSkillRecord, OwnerSkillStore } from "../domain/owner-skills.ts";

const failure = (code: OwnerSkillError["code"], message: string): OwnerSkillError => ({
  type: "owner_skill_error",
  code,
  message,
});

/**
 * Simulation-backed owner skill store. Each command commits synchronously
 * between two scheduling points, modelling the PostgreSQL per-user lock.
 */
export class FakeOwnerSkillStore implements OwnerSkillStore {
  /** Every committed state per user, starting with the implicit empty set. */
  readonly commits: Array<{ userId: string; state: OwnerSkillRecord[] }> = [];
  private readonly skills = new Map<string, OwnerSkillRecord[]>();

  constructor(userIds: Iterable<string> = []) {
    for (const userId of userIds) this.seedUser(userId);
  }

  seedUser(userId: string): void {
    if (!this.skills.has(userId)) this.skills.set(userId, []);
  }

  /** Commits a starting state directly, outside any simulated schedule. */
  seed(userId: string, skills: ReadonlyArray<{ name: string; content: string }>): void {
    const state = skills
      .map((skill) => ({ ...skill, updatedAt: new Date(0).toISOString() }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    this.skills.set(userId, state);
    this.commits.push({ userId, state: state.map((item) => ({ ...item })) });
  }

  statesByUser(userId: string): OwnerSkillRecord[][] {
    return [[], ...this.commits.filter((commit) => commit.userId === userId).map((c) => c.state)];
  }

  list(task: SimulationTask, userId: string) {
    return this.operation(task, "list", userId, (current) => ok(current));
  }
  create(task: SimulationTask, userId: string, skill: { name: string; content: string }) {
    return this.operation(task, "create", userId, (current) => {
      if (current.some((item) => item.name === skill.name))
        return err(failure("conflict", `Skill "${skill.name}" already exists`));
      if (current.length >= OWNER_SKILL_MAX_COUNT)
        return err(failure("conflict", `At most ${OWNER_SKILL_MAX_COUNT} skills`));
      return ok([...current, { ...skill, updatedAt: new Date(task.wallNow()).toISOString() }]);
    });
  }
  replace(
    task: SimulationTask,
    userId: string,
    name: string,
    skill: { name: string; content: string },
  ) {
    return this.operation(task, "replace", userId, (current) => {
      if (!current.some((item) => item.name === name))
        return err(failure("not_found", `Skill "${name}" doesn't exist`));
      if (skill.name !== name && current.some((item) => item.name === skill.name))
        return err(failure("conflict", `Skill "${skill.name}" already exists`));
      return ok([
        ...current.filter((item) => item.name !== name),
        { ...skill, updatedAt: new Date(task.wallNow()).toISOString() },
      ]);
    });
  }
  delete(task: SimulationTask, userId: string, name: string) {
    return this.operation(task, "delete", userId, (current) =>
      current.some((item) => item.name === name)
        ? ok(current.filter((item) => item.name !== name))
        : err(failure("not_found", `Skill "${name}" doesn't exist`)),
    );
  }

  private operation(
    task: SimulationTask,
    name: string,
    userId: string,
    apply: (current: OwnerSkillRecord[]) => Result<OwnerSkillRecord[], OwnerSkillError>,
  ): ResultAsync<OwnerSkillRecord[], OwnerSkillError> {
    if (!this.skills.has(userId))
      return name === "list"
        ? okAsync([])
        : errAsync(failure("internal", "Owner skill storage is inconsistent"));
    return ResultAsync.fromPromise(
      (async () => {
        await task.sleep(1 + task.random("owner skills latency") * 5, name);
        await task.failpoint(`owner-skills.${name}.before`);
        const current = this.skills.get(userId) ?? [];
        const next = apply(current.map((item) => ({ ...item })));
        if (next.isOk() && name !== "list") {
          const sorted = next.value.sort((a, b) => (a.name < b.name ? -1 : 1));
          this.skills.set(userId, sorted);
          this.commits.push({ userId, state: sorted.map((item) => ({ ...item })) });
        }
        await task.sleep(1 + task.random("owner skills reply latency") * 5, `${name} reply`);
        await task.failpoint(`owner-skills.${name}.after`);
        return next.map((items) => items.map((item) => ({ ...item })));
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure("unavailable", "Owner skills unavailable")
          : task.abortSimulation(error),
    ).andThen((result) => result);
  }
}
