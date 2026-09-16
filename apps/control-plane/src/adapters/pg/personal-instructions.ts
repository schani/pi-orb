import {
  type PersonalInstructions,
  PersonalInstructionsSchema,
  validatePersonalInstructions,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { StoreError } from "../../domain/errors.ts";
import type {
  PersonalInstructionsError,
  PersonalInstructionsStore,
} from "../../domain/personal-instructions.ts";
import type { PgQueryResult, PostgreSQLClient } from "./client.ts";

const unavailable = (error?: StoreError): PersonalInstructionsError => ({
  type: "personal_instructions_error",
  code: error?.code === "unavailable" ? "unavailable" : "internal",
  message:
    error?.code === "unavailable"
      ? "Personal instructions unavailable"
      : "Personal instructions storage is inconsistent",
});

function snapshot(result: PgQueryResult) {
  const row = result.rows[0];
  const value = { content: row?.["content"], revision: Number(row?.["revision"]) };
  return Check(PersonalInstructionsSchema, value) &&
    validatePersonalInstructions({ content: value.content }).isOk()
    ? ok<PersonalInstructions, PersonalInstructionsError>(value)
    : err<PersonalInstructions, PersonalInstructionsError>(unavailable());
}

export class PostgreSQLPersonalInstructionsStore implements PersonalInstructionsStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  read(
    _task: SimulationTask,
    userId: string,
  ): ResultAsync<PersonalInstructions, PersonalInstructionsError> {
    return this.db
      .query(
        `SELECT COALESCE(p.content, '') AS content, COALESCE(p.revision, 0) AS revision
         FROM users u LEFT JOIN personal_instructions p ON p.user_id = u.id
         WHERE u.id = $1`,
        [userId],
      )
      .mapErr(unavailable)
      .andThen(snapshot);
  }
  replace(
    _task: SimulationTask,
    userId: string,
    content: string,
  ): ResultAsync<PersonalInstructions, PersonalInstructionsError> {
    return this.db
      .query(
        `INSERT INTO personal_instructions (user_id, content, revision, updated_at)
         SELECT id, $2, 1, now() FROM users WHERE id = $1
         ON CONFLICT (user_id) DO UPDATE
         SET content = EXCLUDED.content,
             revision = personal_instructions.revision + 1,
             updated_at = now()
         RETURNING content, revision`,
        [userId, content],
      )
      .mapErr(unavailable)
      .andThen(snapshot);
  }
}
