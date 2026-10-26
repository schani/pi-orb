import { OWNER_SKILL_MAX_COUNT } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type {
  OwnerSkillError,
  OwnerSkillRecord,
  OwnerSkillStore,
} from "../../domain/owner-skills.ts";
import type { PgQueryResult, PostgreSQLClient } from "./client.ts";

type Query = (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>;
const failure = (code: OwnerSkillError["code"], message: string): OwnerSkillError => ({
  type: "owner_skill_error",
  code,
  message,
});
const storeFailure = (error: StoreError): OwnerSkillError =>
  error.code === "unavailable"
    ? failure("unavailable", "Owner skills unavailable")
    : failure("internal", "Owner skill storage is inconsistent");
const LIST = `SELECT name, content, updated_at FROM user_skills
  WHERE user_id = $1 ORDER BY name COLLATE "C"`;
const records = (result: PgQueryResult): OwnerSkillRecord[] =>
  result.rows.map((row) => ({
    name: String(row["name"]),
    content: String(row["content"]),
    updatedAt: new Date(row["updated_at"] as string | Date).toISOString(),
  }));

/** One row per skill; every command runs under a per-user row lock on `users`. */
export class PostgreSQLOwnerSkillStore implements OwnerSkillStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  list(_task: SimulationTask, userId: string): ResultAsync<OwnerSkillRecord[], OwnerSkillError> {
    return this.db.query(LIST, [userId]).map(records).mapErr(storeFailure);
  }
  create(_task: SimulationTask, userId: string, skill: { name: string; content: string }) {
    return this.locked(userId, async (query) => {
      const current = await query(
        `SELECT count(*)::int AS count, coalesce(bool_or(name = $2), false) AS taken
         FROM user_skills WHERE user_id = $1`,
        [userId, skill.name],
      );
      if (current.isErr()) return err(storeFailure(current.error));
      const row = current.value.rows[0];
      if (row?.["taken"] === true)
        return err(failure("conflict", `Skill "${skill.name}" already exists`));
      if (Number(row?.["count"]) >= OWNER_SKILL_MAX_COUNT)
        return err(failure("conflict", `At most ${OWNER_SKILL_MAX_COUNT} skills`));
      const inserted = await query(
        "INSERT INTO user_skills (user_id, name, content, updated_at) VALUES ($1, $2, $3, now())",
        [userId, skill.name, skill.content],
      );
      return inserted.isErr() ? err(storeFailure(inserted.error)) : ok(undefined);
    });
  }
  replace(
    _task: SimulationTask,
    userId: string,
    name: string,
    skill: { name: string; content: string },
  ) {
    return this.locked(userId, async (query) => {
      if (skill.name !== name) {
        const taken = await query("SELECT 1 FROM user_skills WHERE user_id = $1 AND name = $2", [
          userId,
          skill.name,
        ]);
        if (taken.isErr()) return err(storeFailure(taken.error));
        if (taken.value.rows.length > 0)
          return err(failure("conflict", `Skill "${skill.name}" already exists`));
      }
      // A rename is the same row under its new primary key, in this one statement.
      const updated = await query(
        `UPDATE user_skills SET name = $3, content = $4, updated_at = now()
         WHERE user_id = $1 AND name = $2`,
        [userId, name, skill.name, skill.content],
      );
      if (updated.isErr()) return err(storeFailure(updated.error));
      return updated.value.rowCount === 0
        ? err(failure("not_found", `Skill "${name}" doesn't exist`))
        : ok(undefined);
    });
  }
  delete(_task: SimulationTask, userId: string, name: string) {
    return this.locked(userId, async (query) => {
      const deleted = await query("DELETE FROM user_skills WHERE user_id = $1 AND name = $2", [
        userId,
        name,
      ]);
      if (deleted.isErr()) return err(storeFailure(deleted.error));
      return deleted.value.rowCount === 0
        ? err(failure("not_found", `Skill "${name}" doesn't exist`))
        : ok(undefined);
    });
  }

  private locked(
    userId: string,
    apply: (query: Query) => Promise<Result<void, OwnerSkillError>>,
  ): ResultAsync<OwnerSkillRecord[], OwnerSkillError> {
    return this.db
      .transaction<OwnerSkillRecord[], OwnerSkillError>(async (query) => {
        // Serializes this owner's commands so the count cap and name checks hold.
        const user = await query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
        if (user.isErr()) return err(storeFailure(user.error));
        if (user.value.rows.length === 0)
          return err(failure("internal", "Owner skill storage is inconsistent"));
        const applied = await apply(query);
        if (applied.isErr()) return err(applied.error);
        const listed = await query(LIST, [userId]);
        return listed.isErr() ? err(storeFailure(listed.error)) : ok(records(listed.value));
      })
      .mapErr((error) => (error.type === "owner_skill_error" ? error : storeFailure(error)));
  }
}
