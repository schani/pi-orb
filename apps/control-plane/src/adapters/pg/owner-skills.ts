import type { OwnerSkillFile, OwnerSkillSourceMetadata } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import {
  applyOwnerSkillCommand,
  ownerSkillError as failure,
  type OwnerSkillCommand,
  type OwnerSkillError,
  type OwnerSkillRecord,
  type OwnerSkillStore,
} from "../../domain/owner-skills.ts";
import { jsonParam, type PgQueryResult, type PostgreSQLClient } from "./client.ts";

const storeFailure = (error: StoreError): OwnerSkillError =>
  error.code === "unavailable"
    ? failure("unavailable", "Owner skills unavailable")
    : failure("internal", "Owner skill storage is inconsistent");
const LIST = `SELECT name, content, files, source, updated_at FROM user_skills
  WHERE user_id = $1 ORDER BY name COLLATE "C"`;
const records = (result: PgQueryResult): OwnerSkillRecord[] =>
  result.rows.map((row) => ({
    name: String(row["name"]),
    content: String(row["content"]),
    files: row["files"] as OwnerSkillFile[],
    source: row["source"] as OwnerSkillSourceMetadata | null,
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
  apply(_task: SimulationTask, userId: string, command: OwnerSkillCommand, signal?: AbortSignal) {
    return this.db
      .transaction<OwnerSkillRecord[], OwnerSkillError>(async (query) => {
        // Serializes name, count and aggregate-byte checks with the write.
        const user = await query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
        if (user.isErr()) return err(storeFailure(user.error));
        if (user.value.rows.length === 0)
          return err(failure("internal", "Owner skill storage is inconsistent"));
        const current = await query(LIST, [userId]);
        if (current.isErr()) return err(storeFailure(current.error));
        const checked = applyOwnerSkillCommand(records(current.value), command, "");
        if (checked.isErr()) return err(checked.error);
        if (signal?.aborted) return err(failure("unavailable", "Skill import cancelled"));
        // A rename is the same row under its new primary key, in one statement.
        const written = await (command.kind === "create"
          ? query(
              `INSERT INTO user_skills (user_id, name, content, files, source, updated_at)
               VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now())`,
              [
                userId,
                command.skill.name,
                command.skill.content,
                jsonParam(command.skill.files),
                jsonParam(command.skill.source),
              ],
            )
          : command.kind === "replace"
            ? query(
                `UPDATE user_skills SET name = $3, content = $4, updated_at = now()
                 WHERE user_id = $1 AND name = $2`,
                [userId, command.name, command.skill.name, command.skill.content],
              )
            : query("DELETE FROM user_skills WHERE user_id = $1 AND name = $2", [
                userId,
                command.name,
              ]));
        if (written.isErr()) return err(storeFailure(written.error));
        const listed = await query(LIST, [userId]);
        if (signal?.aborted) return err(failure("unavailable", "Skill import cancelled"));
        return listed.isErr() ? err(storeFailure(listed.error)) : ok(records(listed.value));
      })
      .mapErr((error) => (error.type === "owner_skill_error" ? error : storeFailure(error)));
  }
}
